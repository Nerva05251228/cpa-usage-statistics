package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := openStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	return s
}

func TestStorePersistsIdenticalLiveRequestsWithoutCredentials(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			_ = s.close()
		}
	})
	record := UsageRecord{
		APIKey: "sk-client-secret-not-for-storage", Source: "sk-upstream-secret-not-for-storage",
		AuthIndex: "credential-private-reference", AuthID: "credential-private-id",
		Model: "test-model", Provider: "openai", RequestedAt: time.Now().UTC(), Latency: 1500 * time.Millisecond,
		Detail: UsageDetail{InputTokens: 10, OutputTokens: 5, TotalTokens: 15},
	}
	for i := 0; i < 2; i++ {
		if err := s.enqueue(record); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.flush(); err != nil {
		t.Fatal(err)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	closed = true

	s, err = openStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed = false
	snapshot, err := s.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalRequests != 2 || snapshot.SuccessCount != 2 || snapshot.TotalTokens != 30 {
		t.Fatalf("persisted totals = %+v", snapshot)
	}
	var details []RequestDetail
	for _, api := range snapshot.APIs {
		for _, model := range api.Models {
			details = append(details, model.Details...)
		}
	}
	if len(details) != 2 || details[0].EventID == details[1].EventID {
		t.Fatalf("identical requests were collapsed: %+v", details)
	}
	if details[0].LatencyMs != 1500 {
		t.Fatalf("latency = %d; want 1500", details[0].LatencyMs)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	secrets := []string{record.APIKey, record.Source, record.AuthIndex, record.AuthID}
	assertNoSecrets := func(name string, raw []byte) {
		t.Helper()
		for _, secret := range secrets {
			if bytes.Contains(raw, []byte(secret)) {
				t.Errorf("%s contains credential %q", name, secret)
			}
		}
	}
	assertNoSecrets("statistics response", encoded)
	if err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		assertNoSecrets(filepath.Base(path), raw)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyImportRebuildsTotalsAndDeduplicatesRepeatUploads(t *testing.T) {
	s := newTestStore(t)
	// Top-level counters are intentionally inconsistent with the details. Import
	// must rebuild them instead of counting both the aggregates and the events.
	raw := []byte(`{"version":1,"usage":{"total_requests":999,"failure_count":500,"total_tokens":99999,
		"apis":{"sk-legacy-client":{"total_requests":500,"models":{"legacy-model":{"total_requests":500,"details":[
			{"timestamp":"2026-09-10T01:00:00Z","latency_ms":75,"source":"sk-legacy-upstream","client_source":"legacy label","auth_index":"legacy-auth","tokens":{"input_tokens":100,"output_tokens":20,"reasoning_tokens":5,"cached_tokens":40,"total_tokens":120},"failed":false},
			{"timestamp":"2026-09-10T01:01:00Z","latency_ms":25,"source":"sk-legacy-upstream","client_source":"legacy label","auth_index":"legacy-auth","tokens":{"input_tokens":2,"output_tokens":0,"total_tokens":2},"failed":true}
		]}}}}}}`)
	first, err := s.importUsage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if first.Added != 2 || first.Skipped != 0 {
		t.Fatalf("first import = %+v", first)
	}
	second, err := s.importUsage(raw)
	if err != nil {
		t.Fatal(err)
	}
	if second.Added != 0 || second.Skipped != 2 {
		t.Fatalf("repeat import = %+v", second)
	}
	snapshot, err := s.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalRequests != 2 || snapshot.SuccessCount != 1 || snapshot.FailureCount != 1 || snapshot.TotalTokens != 122 {
		t.Fatalf("imported totals must come from details: %+v", snapshot)
	}
	for apiID, api := range snapshot.APIs {
		if apiID == "sk-legacy-client" {
			t.Fatal("raw client key retained after import")
		}
		for _, model := range api.Models {
			for _, detail := range model.Details {
				if !detail.LegacyAccounting {
					t.Fatal("legacy import lost its explicit legacy billing marker")
				}
				if detail.TokenBreakdown.Quality == "complete" || detail.TokenBreakdown.UnclassifiedTokens != detail.Tokens.TotalTokens {
					t.Fatalf("legacy counters were promoted to unsupported canonical buckets: %+v", detail)
				}
			}
		}
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"sk-legacy-client", "sk-legacy-upstream", "legacy label", "legacy-auth"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Errorf("imported snapshot retained %q", secret)
		}
	}
}

func TestImportRejectsMalformedOrUnsupportedDataWithoutMutatingStore(t *testing.T) {
	s := newTestStore(t)
	for _, raw := range []string{`{"version":1`, `{"version":999,"usage":{"apis":{}}}`} {
		if _, err := s.importUsage([]byte(raw)); err == nil {
			t.Fatalf("invalid import accepted: %s", raw)
		}
	}
	snapshot, err := s.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalRequests != 0 {
		t.Fatalf("invalid import changed totals: %+v", snapshot)
	}
}

func TestBillingPersistenceAndInvalidUpdateLeavesPreviousSettings(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	settings := Billing{ResetTimezone: "America/New_York", ModelPrices: map[string]ModelPrice{"model": {Prompt: 2.5, Completion: 10, Cache: 0.25}}}
	if err := s.saveBilling(settings); err != nil {
		_ = s.close()
		t.Fatal(err)
	}
	if err := s.saveBilling(Billing{ResetTimezone: "invalid/timezone"}); err == nil {
		_ = s.close()
		t.Fatal("invalid billing update accepted")
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	s, err = openStore(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	got, err := s.billing()
	if err != nil {
		t.Fatal(err)
	}
	if got.ResetTimezone != settings.ResetTimezone || got.ModelPrices["model"] != settings.ModelPrices["model"] {
		t.Fatalf("saved billing settings changed: %+v", got)
	}
}

func TestSnapshotFiltersFractionalSecondsAndPaginatesDetailsWithoutTruncatingTotals(t *testing.T) {
	s := newTestStore(t)
	start := time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)
	for i, offset := range []time.Duration{0, 100 * time.Millisecond, 900 * time.Millisecond} {
		r := UsageRecord{APIKey: "client", Model: "selected", RequestedAt: start.Add(offset), Failed: i == 2, Detail: UsageDetail{TotalTokens: 10}}
		if err := s.enqueue(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.enqueue(UsageRecord{Model: "other", RequestedAt: start, Detail: UsageDetail{TotalTokens: 100}}); err != nil {
		t.Fatal(err)
	}
	query := url.Values{
		"from": {start.Format(time.RFC3339Nano)}, "to": {start.Add(time.Second).Format(time.RFC3339Nano)},
		"model": {"selected"}, "page_size": {"1"}, "page": {"1"},
	}
	firstPage, err := s.snapshot(query)
	if err != nil {
		t.Fatal(err)
	}
	if firstPage.TotalRequests != 3 || firstPage.TotalTokens != 30 || firstPage.FailureCount != 1 {
		t.Fatalf("fractional timestamp filtering or aggregate pagination is incorrect: %+v", firstPage)
	}
	flatten := func(snapshot StatisticsSnapshot) []RequestDetail {
		var details []RequestDetail
		for _, api := range snapshot.APIs {
			for _, model := range api.Models {
				details = append(details, model.Details...)
			}
		}
		return details
	}
	details := flatten(firstPage)
	if len(details) != 1 || !details[0].Timestamp.Equal(start.Add(900*time.Millisecond)) {
		t.Fatalf("first page must contain the most recent event: %+v", details)
	}
	query.Set("page", "3")
	lastPage, err := s.snapshot(query)
	if err != nil {
		t.Fatal(err)
	}
	details = flatten(lastPage)
	if lastPage.TotalRequests != 3 || len(details) != 1 || !details[0].Timestamp.Equal(start) {
		t.Fatalf("last page must preserve aggregate totals and contain the oldest event: %+v", lastPage)
	}
	query.Set("details", "false")
	aggregates, err := s.snapshot(query)
	if err != nil {
		t.Fatal(err)
	}
	if aggregates.TotalRequests != 3 || len(flatten(aggregates)) != 0 {
		t.Fatalf("summary-only query has incorrect totals or unexpected details: %+v", aggregates)
	}
}

func TestSnapshotUsesConfiguredDayBoundary(t *testing.T) {
	s := newTestStore(t)
	if err := s.saveBilling(Billing{ResetTimezone: "Asia/Shanghai"}); err != nil {
		t.Fatal(err)
	}
	for _, timestamp := range []string{"2026-09-09T15:59:59Z", "2026-09-09T16:00:00Z"} {
		at, err := time.Parse(time.RFC3339, timestamp)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.enqueue(UsageRecord{Model: "model", RequestedAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := s.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.RequestsByDay["2026-09-09"] != 1 || snapshot.RequestsByDay["2026-09-10"] != 1 || snapshot.RequestsByHour["23"] != 1 || snapshot.RequestsByHour["0"] != 1 {
		t.Fatalf("statistics ignored configured timezone: %+v", snapshot)
	}
}

func TestConcurrentSnapshotsKeepDetailsConsistentWithTotals(t *testing.T) {
	s := newTestStore(t)
	writeDone := make(chan error, 1)
	go func() {
		for i := 0; i < 200; i++ {
			if err := s.enqueue(UsageRecord{APIKey: fmt.Sprintf("client-%d", i), Model: "model", RequestedAt: time.Now().UTC(), Detail: UsageDetail{TotalTokens: 1}}); err != nil {
				writeDone <- err
				return
			}
		}
		writeDone <- nil
	}()
	for i := 0; i < 20; i++ {
		snapshot, err := s.snapshot(nil)
		if err != nil {
			t.Fatal(err)
		}
		var details int64
		for _, api := range snapshot.APIs {
			for _, model := range api.Models {
				details += int64(len(model.Details))
			}
		}
		if details != snapshot.TotalRequests || snapshot.TotalTokens != snapshot.TotalRequests {
			t.Fatalf("concurrent write split snapshot: details=%d, requests=%d, tokens=%d", details, snapshot.TotalRequests, snapshot.TotalTokens)
		}
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
}

func TestStoreRejectsFutureSchemaWithoutChangingDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version=2; CREATE TABLE future_marker(value TEXT NOT NULL); INSERT INTO future_marker(value) VALUES('retain-future-data');`); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if store, err := openStore(dir, 0); err == nil {
		_ = store.close()
		t.Error("older plugin accepted a database from a newer schema")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Errorf("rejected downgrade changed schema version to %d", version)
	}
	var marker string
	if err := db.QueryRow("SELECT value FROM future_marker").Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != "retain-future-data" {
		t.Errorf("rejected downgrade changed stored data: %q", marker)
	}
}
