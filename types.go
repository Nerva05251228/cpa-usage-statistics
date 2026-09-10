package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"
)

const pluginID = "cpa-usage-statistics"
const pluginVersion = "0.1.3"
const apiBase = "/v0/management/plugins/" + pluginID
const resourcePath = "/v0/resource/plugins/" + pluginID + "/index.html"

// Wire types intentionally do not import host packages, keeping the binary independent.
type UsageRecord struct {
	Provider, ExecutorType, Model, Alias, APIKey, AuthIndex, AuthID, AuthType, Source string
	RequestedAt                                                                       time.Time
	Latency                                                                           time.Duration
	Failed                                                                            bool
	Detail                                                                            UsageDetail
}
type UsageDetail struct {
	InputTokens, OutputTokens, ReasoningTokens, CachedTokens, CacheReadTokens, CacheCreationTokens, TotalTokens int64
	TokenBreakdown                                                                                              TokenBreakdown
}
type TokenBreakdown struct {
	SchemaVersion      int         `json:"schema_version"`
	Quality            string      `json:"quality"`
	TotalTokens        int64       `json:"total_tokens"`
	Input              TokenInput  `json:"input"`
	Output             TokenOutput `json:"output"`
	UnclassifiedTokens int64       `json:"unclassified_tokens"`
}
type TokenInput struct {
	TotalTokens      int64 `json:"total_tokens"`
	UncachedTokens   int64 `json:"uncached_tokens"`
	CacheReadTokens  int64 `json:"cache_read_tokens"`
	CacheWriteTokens int64 `json:"cache_write_tokens"`
}
type TokenOutput struct {
	TotalTokens        int64 `json:"total_tokens"`
	NonReasoningTokens int64 `json:"non_reasoning_tokens"`
	ReasoningTokens    int64 `json:"reasoning_tokens"`
}

func (b TokenBreakdown) valid() bool {
	if b.SchemaVersion != 2 || (b.Quality != "complete" && b.Quality != "unclassified" && b.Quality != "inconsistent") {
		return false
	}
	values := []int64{b.TotalTokens, b.UnclassifiedTokens, b.Input.TotalTokens, b.Input.UncachedTokens, b.Input.CacheReadTokens, b.Input.CacheWriteTokens, b.Output.TotalTokens, b.Output.NonReasoningTokens, b.Output.ReasoningTokens}
	for _, v := range values {
		if v < 0 {
			return false
		}
	}
	return safeSum(b.Input.UncachedTokens, b.Input.CacheReadTokens, b.Input.CacheWriteTokens) == b.Input.TotalTokens && safeSum(b.Output.NonReasoningTokens, b.Output.ReasoningTokens) == b.Output.TotalTokens && safeSum(b.Input.TotalTokens, b.Output.TotalTokens, b.UnclassifiedTokens) == b.TotalTokens && (b.Quality != "complete" || b.UnclassifiedTokens == 0)
}
func safeSum(vs ...int64) int64 {
	var n int64
	for _, v := range vs {
		if v < 0 || n > math.MaxInt64-v {
			return -1
		}
		n += v
	}
	return n
}

type TokenStats struct {
	InputTokens         int64 `json:"input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	ReasoningTokens     int64 `json:"reasoning_tokens"`
	CachedTokens        int64 `json:"cached_tokens"`
	CacheReadTokens     int64 `json:"cache_read_tokens,omitempty"`
	CacheCreationTokens int64 `json:"cache_creation_tokens,omitempty"`
	TotalTokens         int64 `json:"total_tokens"`
}
type RequestDetail struct {
	LegacyAccounting bool           `json:"legacy_accounting,omitempty"`
	EventID          string         `json:"event_id,omitempty"`
	Timestamp        time.Time      `json:"timestamp"`
	LatencyMs        int64          `json:"latency_ms"`
	Source           string         `json:"source"`
	ClientSource     string         `json:"client_source,omitempty"`
	AuthIndex        string         `json:"auth_index"`
	Provider         string         `json:"provider,omitempty"`
	Tokens           TokenStats     `json:"tokens"`
	RawTokens        TokenStats     `json:"raw_tokens"`
	TokenBreakdown   TokenBreakdown `json:"token_breakdown"`
	Failed           bool           `json:"failed"`
}
type StatisticsSnapshot struct {
	TotalRequests  int64                  `json:"total_requests"`
	SuccessCount   int64                  `json:"success_count"`
	FailureCount   int64                  `json:"failure_count"`
	TotalTokens    int64                  `json:"total_tokens"`
	APIs           map[string]APISnapshot `json:"apis"`
	RequestsByDay  map[string]int64       `json:"requests_by_day"`
	RequestsByHour map[string]int64       `json:"requests_by_hour"`
	TokensByDay    map[string]int64       `json:"tokens_by_day"`
	TokensByHour   map[string]int64       `json:"tokens_by_hour"`
}
type APISnapshot struct {
	TotalRequests int64                    `json:"total_requests"`
	TotalTokens   int64                    `json:"total_tokens"`
	Models        map[string]ModelSnapshot `json:"models"`
}
type ModelSnapshot struct {
	TotalRequests int64           `json:"total_requests"`
	TotalTokens   int64           `json:"total_tokens"`
	Details       []RequestDetail `json:"details"`
}
type ModelPrice struct {
	Prompt     float64 `json:"prompt"`
	Completion float64 `json:"completion"`
	Cache      float64 `json:"cache"`
}
type Billing struct {
	ResetTimezone string                `json:"reset-timezone"`
	ModelPrices   map[string]ModelPrice `json:"model-prices"`
}

func defaultBilling() Billing {
	return Billing{ResetTimezone: "Asia/Shanghai", ModelPrices: map[string]ModelPrice{}}
}
func validateBilling(b *Billing) error {
	if b.ResetTimezone == "" {
		b.ResetTimezone = "Asia/Shanghai"
	}
	if _, err := time.LoadLocation(b.ResetTimezone); err != nil {
		return fmt.Errorf("invalid reset-timezone")
	}
	if b.ModelPrices == nil {
		b.ModelPrices = map[string]ModelPrice{}
	}
	if len(b.ModelPrices) > 10000 {
		return fmt.Errorf("too many model prices")
	}
	for k, p := range b.ModelPrices {
		if strings.TrimSpace(k) == "" || len(k) > 512 {
			return fmt.Errorf("invalid model name")
		}
		for _, v := range []float64{p.Prompt, p.Completion, p.Cache} {
			if v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
				return fmt.Errorf("prices must be finite and non-negative")
			}
		}
	}
	return nil
}

type ManagementRequest struct {
	Method, Path   string
	Headers        http.Header
	Query          url.Values
	Body           []byte
	HostCallbackID string `json:"host_callback_id,omitempty"`
}
type ManagementResponse struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
}
type storedEvent struct {
	API, Model string
	Detail     RequestDetail
}
type ImportResult struct {
	Added          int64 `json:"added"`
	Skipped        int64 `json:"skipped"`
	TotalRequests  int64 `json:"total_requests"`
	FailedRequests int64 `json:"failed_requests"`
}

var opaquePattern = regexp.MustCompile(`^(key|source|credential)-[a-f0-9]{24}$`)
var eventPattern = regexp.MustCompile(`^(event|import)-[a-f0-9]{64}$`)

func fingerprint(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func opaque(prefix, value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "unknown" {
		return "unknown"
	}
	if strings.HasPrefix(value, prefix+"-") && opaquePattern.MatchString(value) {
		return value
	}
	return prefix + "-" + fingerprint(value)[:24]
}

// rawOpaque always hashes host input, even when a raw key resembles a stored ID.
func rawOpaque(prefix, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	return prefix + "-" + fingerprint(value)[:24]
}
func normalTokens(t TokenStats) TokenStats {
	t.InputTokens = max(0, t.InputTokens)
	t.OutputTokens = max(0, t.OutputTokens)
	t.ReasoningTokens = max(0, t.ReasoningTokens)
	t.CachedTokens = max(0, t.CachedTokens)
	t.CacheReadTokens = max(0, t.CacheReadTokens)
	t.CacheCreationTokens = max(0, t.CacheCreationTokens)
	t.TotalTokens = max(0, t.TotalTokens)
	if t.TotalTokens == 0 {
		t.TotalTokens = max(0, safeSum(t.InputTokens, t.OutputTokens))
	}
	return t
}
func normalizedBreakdown(b TokenBreakdown, t TokenStats) TokenBreakdown {
	if b.valid() {
		return b
	}
	return TokenBreakdown{SchemaVersion: 2, Quality: "unclassified", TotalTokens: t.TotalTokens, UnclassifiedTokens: t.TotalTokens}
}
func sanitizeEvent(e storedEvent) storedEvent {
	e.API = opaque("key", e.API)
	e.Model = strings.TrimSpace(e.Model)
	if e.Model == "" {
		e.Model = "unknown"
	}
	if len(e.Model) > 512 {
		e.Model = e.Model[:512]
	}
	d := &e.Detail
	d.Source = opaque("source", d.Source)
	d.AuthIndex = opaque("credential", d.AuthIndex)
	d.ClientSource = e.API
	d.Provider = strings.TrimSpace(d.Provider)
	if len(d.Provider) > 64 {
		d.Provider = "unknown"
	}
	if d.Timestamp.IsZero() {
		d.Timestamp = time.Now().UTC()
	}
	d.Timestamp = d.Timestamp.UTC()
	d.LatencyMs = max(0, d.LatencyMs)
	d.Tokens = normalTokens(d.Tokens)
	d.TokenBreakdown = normalizedBreakdown(d.TokenBreakdown, d.Tokens)
	d.Tokens.TotalTokens = d.TokenBreakdown.TotalTokens
	return e
}
func eventFromRecord(r UsageRecord) (storedEvent, error) {
	var id [32]byte
	if _, err := rand.Read(id[:]); err != nil {
		return storedEvent{}, err
	}
	t := TokenStats{r.Detail.InputTokens, r.Detail.OutputTokens, r.Detail.ReasoningTokens, r.Detail.CachedTokens, r.Detail.CacheReadTokens, r.Detail.CacheCreationTokens, r.Detail.TotalTokens}
	return sanitizeEvent(storedEvent{API: rawOpaque("key", r.APIKey), Model: r.Model, Detail: RequestDetail{EventID: "event-" + hex.EncodeToString(id[:]), Timestamp: r.RequestedAt, LatencyMs: r.Latency.Milliseconds(), Source: rawOpaque("source", r.Source), AuthIndex: rawOpaque("credential", r.AuthIndex), Provider: r.Provider, Tokens: t, RawTokens: t, TokenBreakdown: r.Detail.TokenBreakdown, Failed: r.Failed}}), nil
}
func jsonResponse(status int, body any) ManagementResponse {
	raw, err := json.Marshal(body)
	if err != nil {
		status = 500
		raw = []byte(`{"error":"response encoding failed"}`)
	}
	return ManagementResponse{StatusCode: status, Headers: http.Header{"Content-Type": {"application/json; charset=utf-8"}, "Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}}, Body: raw}
}
