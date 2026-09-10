package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

const queueSize = 4096
const dbTimeFormat = "2006-01-02T15:04:05.000000000Z"
const maxImportBytes = 64 << 20

var errClosed = errors.New("statistics store is closed")
var errQueueFull = errors.New("statistics writer queue is full")

type writeItem struct {
	event   *storedEvent
	barrier chan error
}
type Store struct {
	db            *sql.DB
	queue         chan writeItem
	done          chan struct{}
	mu            sync.Mutex
	closed        bool
	retentionDays int
	dropped       atomic.Int64
	errorMu       sync.Mutex
	lastError     string
}

func openStore(dir string, retentionDays int) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create statistics directory: %w", err)
	}
	path := filepath.Join(dir, "usage.sqlite")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("create statistics database: %w", err)
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var schemaVersion int
	if err = db.QueryRow("PRAGMA user_version").Scan(&schemaVersion); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("read statistics schema: %w", err)
	}
	if schemaVersion > 1 {
		_ = db.Close()
		return nil, fmt.Errorf("statistics schema version %d is newer than supported version 1", schemaVersion)
	}
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,api TEXT NOT NULL,model TEXT NOT NULL,timestamp TEXT NOT NULL,total_tokens INTEGER NOT NULL,failed INTEGER NOT NULL,detail TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS events_timestamp ON events(timestamp);
 CREATE INDEX IF NOT EXISTS events_api_model ON events(api,model);
 CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 PRAGMA user_version=1;`)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize statistics database: %w", err)
	}
	s := &Store{db: db, queue: make(chan writeItem, queueSize), done: make(chan struct{}), retentionDays: retentionDays}
	if err = s.prune(); err != nil {
		_ = db.Close()
		return nil, err
	}
	go s.runWriter()
	return s, nil
}
func (s *Store) rememberError(err error) {
	if err == nil {
		return
	}
	s.errorMu.Lock()
	s.lastError = err.Error()
	s.errorMu.Unlock()
}
func (s *Store) errorStatus() string {
	s.errorMu.Lock()
	defer s.errorMu.Unlock()
	if s.lastError != "" {
		return "statistics persistence failed; inspect server storage permissions and disk space"
	}
	return ""
}
func (s *Store) runWriter() {
	defer close(s.done)
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case item, ok := <-s.queue:
			if !ok {
				return
			}
			if item.barrier != nil {
				item.barrier <- s.writerError()
				continue
			}
			if item.event != nil {
				_, err := insertEvent(s.db, *item.event)
				s.rememberError(err)
			}
		case <-ticker.C:
			s.rememberError(s.prune())
		}
	}
}
func (s *Store) writerError() error {
	s.errorMu.Lock()
	defer s.errorMu.Unlock()
	if s.lastError != "" {
		return errors.New("statistics persistence failed")
	}
	return nil
}
func (s *Store) enqueue(record UsageRecord) error {
	event, err := eventFromRecord(record)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errClosed
	}
	select {
	case s.queue <- writeItem{event: &event}:
		return nil
	default:
		s.dropped.Add(1)
		return errQueueFull
	}
}
func (s *Store) flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errClosed
	}
	barrier := make(chan error, 1)
	s.queue <- writeItem{barrier: barrier}
	return <-barrier
}
func (s *Store) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	close(s.queue)
	<-s.done
	errWrite := s.writerError()
	errClose := s.db.Close()
	if errWrite != nil {
		return errWrite
	}
	return errClose
}
func (s *Store) prune() error {
	if s.retentionDays <= 0 {
		return nil
	}
	_, err := s.db.Exec("DELETE FROM events WHERE timestamp < ?", time.Now().UTC().AddDate(0, 0, -s.retentionDays).Format(dbTimeFormat))
	return err
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
}

func insertEvent(db execer, event storedEvent) (bool, error) {
	raw, err := json.Marshal(event.Detail)
	if err != nil {
		return false, err
	}
	result, err := db.Exec("INSERT OR IGNORE INTO events(event_id,api,model,timestamp,total_tokens,failed,detail) VALUES (?,?,?,?,?,?,?)", event.Detail.EventID, event.API, event.Model, event.Detail.Timestamp.UTC().Format(dbTimeFormat), event.Detail.Tokens.TotalTokens, event.Detail.Failed, string(raw))
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}
func (s *Store) billing() (Billing, error) {
	b := defaultBilling()
	var raw string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key='billing'").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return b, nil
	}
	if err != nil {
		return b, err
	}
	if err = json.Unmarshal([]byte(raw), &b); err != nil {
		return b, err
	}
	return b, validateBilling(&b)
}
func (s *Store) saveBilling(b Billing) error {
	if err := validateBilling(&b); err != nil {
		return err
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("INSERT INTO settings(key,value) VALUES('billing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(raw))
	return err
}
func newSnapshot() StatisticsSnapshot {
	return StatisticsSnapshot{APIs: map[string]APISnapshot{}, RequestsByDay: map[string]int64{}, RequestsByHour: map[string]int64{}, TokensByDay: map[string]int64{}, TokensByHour: map[string]int64{}}
}
func queryFilter(query url.Values) (string, []any, error) {
	where := " WHERE 1=1"
	var args []any
	for _, key := range []string{"from", "to"} {
		if v := strings.TrimSpace(query.Get(key)); v != "" {
			stamp, err := time.Parse(time.RFC3339Nano, v)
			if err != nil {
				return "", nil, fmt.Errorf("%s must be an RFC3339 timestamp", key)
			}
			op := ">="
			if key == "to" {
				op = "<="
			}
			where += " AND timestamp " + op + " ?"
			args = append(args, stamp.UTC().Format(dbTimeFormat))
		}
	}
	for _, key := range []string{"api", "model"} {
		if v := query.Get(key); v != "" {
			where += " AND " + key + " = ?"
			args = append(args, v)
		}
	}
	if v := query.Get("failed"); v != "" {
		if v != "true" && v != "false" {
			return "", nil, fmt.Errorf("failed must be true or false")
		}
		where += " AND failed = ?"
		args = append(args, v == "true")
	}
	return where, args, nil
}
func pagination(query url.Values) (int, int, error) {
	size, page := 0, 1
	if v := query.Get("page_size"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 5000 {
			return 0, 0, errors.New("page_size must be between 1 and 5000")
		}
		size = n
	}
	if v := query.Get("page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000000 {
			return 0, 0, errors.New("page must be between 1 and 1000000")
		}
		page = n
	}
	return size, page, nil
}
func (s *Store) snapshot(query url.Values) (StatisticsSnapshot, error) {
	snap := newSnapshot()
	if err := s.flush(); err != nil {
		return snap, err
	}
	where, args, err := queryFilter(query)
	if err != nil {
		return snap, err
	}
	size, page, err := pagination(query)
	if err != nil {
		return snap, err
	}
	b, err := s.billing()
	if err != nil {
		return snap, err
	}
	location, err := time.LoadLocation(b.ResetTimezone)
	if err != nil {
		return snap, err
	}
	// A read transaction keeps aggregates and page details on the same SQLite snapshot.
	tx, err := s.db.Begin()
	if err != nil {
		return snap, err
	}
	defer tx.Rollback()
	// Aggregate compact rows on the server; only detail rows require JSON decoding.
	rows, err := tx.Query("SELECT api,model,timestamp,total_tokens,failed FROM events"+where, args...)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var api, model, stamp string
		var total int64
		var failed bool
		if err = rows.Scan(&api, &model, &stamp, &total, &failed); err != nil {
			break
		}
		timestamp, errParse := time.Parse(time.RFC3339Nano, stamp)
		if errParse != nil {
			err = errParse
			break
		}
		timestamp = timestamp.In(location)
		a := snap.APIs[api]
		if a.Models == nil {
			a.Models = map[string]ModelSnapshot{}
		}
		m := a.Models[model]
		if m.Details == nil {
			m.Details = []RequestDetail{}
		}
		m.TotalRequests++
		m.TotalTokens += total
		a.TotalRequests++
		a.TotalTokens += total
		a.Models[model] = m
		snap.APIs[api] = a
		snap.TotalRequests++
		snap.TotalTokens += total
		if failed {
			snap.FailureCount++
		} else {
			snap.SuccessCount++
		}
		day, hour := timestamp.Format("2006-01-02"), strconv.Itoa(timestamp.Hour())
		snap.RequestsByDay[day]++
		snap.TokensByDay[day] += total
		snap.RequestsByHour[hour]++
		snap.TokensByHour[hour] += total
	}
	errRows := rows.Err()
	errClose := rows.Close()
	if err != nil {
		return snap, err
	}
	if errRows != nil {
		return snap, errRows
	}
	if errClose != nil {
		return snap, errClose
	}
	if query.Get("details") == "false" {
		return snap, nil
	}
	detailSQL := "SELECT api,model,detail FROM events" + where + " ORDER BY timestamp DESC,id DESC"
	detailArgs := append([]any(nil), args...)
	if size > 0 {
		detailSQL += " LIMIT ? OFFSET ?"
		detailArgs = append(detailArgs, size, (page-1)*size)
	}
	rows, err = tx.Query(detailSQL, detailArgs...)
	if err != nil {
		return snap, err
	}
	defer rows.Close()
	for rows.Next() {
		var api, model, raw string
		if err = rows.Scan(&api, &model, &raw); err != nil {
			return snap, err
		}
		var d RequestDetail
		if err = json.Unmarshal([]byte(raw), &d); err != nil {
			return snap, err
		}
		a := snap.APIs[api]
		m := a.Models[model]
		m.Details = append(m.Details, d)
		a.Models[model] = m
		snap.APIs[api] = a
	}
	return snap, rows.Err()
}
func (s *Store) importUsage(raw []byte) (ImportResult, error) {
	var result ImportResult
	if len(raw) > maxImportBytes {
		return result, errors.New("import exceeds 64 MiB")
	}
	var payload struct {
		Version int                 `json:"version"`
		Usage   *StatisticsSnapshot `json:"usage"`
		Billing *Billing            `json:"billing"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return result, errors.New("invalid import JSON")
	}
	if payload.Version != 0 && payload.Version != 1 {
		return result, errors.New("unsupported import version")
	}
	if payload.Usage == nil {
		return result, errors.New("usage snapshot is required")
	}
	if payload.Billing != nil {
		if err := validateBilling(payload.Billing); err != nil {
			return result, err
		}
	}
	if err := s.flush(); err != nil {
		return result, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	for api, a := range payload.Usage.APIs {
		for model, m := range a.Models {
			for _, detail := range m.Details {
				apiForEvent := api
				// Hash the original detail before redaction or missing-timestamp normalization.
				if !eventPattern.MatchString(detail.EventID) {
					original, errMarshal := json.Marshal(struct {
						API, Model string
						Detail     RequestDetail
					}{api, model, detail})
					if errMarshal != nil {
						return result, errMarshal
					}
					detail.EventID = "import-" + fingerprint(string(original))
					apiForEvent = rawOpaque("key", api)
					detail.Source = rawOpaque("source", detail.Source)
					detail.AuthIndex = rawOpaque("credential", detail.AuthIndex)
				}
				if !detail.TokenBreakdown.valid() {
					detail.LegacyAccounting = true
				}
				if detail.RawTokens == (TokenStats{}) {
					detail.RawTokens = detail.Tokens
				}
				event := sanitizeEvent(storedEvent{API: apiForEvent, Model: model, Detail: detail})
				added, errInsert := insertEvent(tx, event)
				if errInsert != nil {
					return result, errInsert
				}
				if added {
					result.Added++
				} else {
					result.Skipped++
				}
			}
		}
	}
	if payload.Billing != nil {
		billingRaw, errMarshal := json.Marshal(payload.Billing)
		if errMarshal != nil {
			return result, errMarshal
		}
		if _, err = tx.Exec("INSERT INTO settings(key,value) VALUES('billing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(billingRaw)); err != nil {
			return result, err
		}
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	err = s.db.QueryRow("SELECT COUNT(*),COALESCE(SUM(failed),0) FROM events").Scan(&result.TotalRequests, &result.FailedRequests)
	return result, err
}

type Source struct {
	ID        string `json:"id"`
	AuthIndex string `json:"auth_index"`
	Source    string `json:"source"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	Type      string `json:"type"`
	Disabled  bool   `json:"disabled"`
}

func (s *Store) sources() ([]Source, error) {
	if err := s.flush(); err != nil {
		return nil, err
	}
	rows, err := s.db.Query("SELECT DISTINCT json_extract(detail,'$.auth_index'),json_extract(detail,'$.source'),COALESCE(json_extract(detail,'$.provider'),'') FROM events")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sources := []Source{}
	seen := map[string]bool{}
	for rows.Next() {
		var index, source, provider string
		if err = rows.Scan(&index, &source, &provider); err != nil {
			return nil, err
		}
		id := index
		if id == "unknown" {
			id = source
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		sources = append(sources, Source{ID: id, AuthIndex: index, Source: source, Provider: provider, Label: id, Type: "observed"})
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].ID < sources[j].ID })
	return sources, rows.Err()
}
