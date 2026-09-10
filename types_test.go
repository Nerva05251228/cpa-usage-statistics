package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

// This fixture uses the host's wire spelling and nanosecond duration units.
// Keeping it as JSON catches accidental changes to the standalone ABI types.
func TestHostUsageWirePreservesCanonicalAccounting(t *testing.T) {
	raw := []byte(`{
		"Provider":"openai","ExecutorType":"openai","Model":"test-model",
		"APIKey":"sk-client-test-secret","AuthIndex":"test-credential",
		"Source":"sk-upstream-test-secret","RequestedAt":"2026-09-10T01:02:03Z",
		"Latency":1250000000,"Failed":false,
		"Detail":{"InputTokens":100,"OutputTokens":30,"ReasoningTokens":12,
			"CachedTokens":40,"CacheReadTokens":40,"CacheCreationTokens":10,"TotalTokens":130,
			"TokenBreakdown":{"schema_version":2,"quality":"complete","total_tokens":130,
				"input":{"total_tokens":100,"uncached_tokens":50,"cache_read_tokens":40,"cache_write_tokens":10},
				"output":{"total_tokens":30,"non_reasoning_tokens":18,"reasoning_tokens":12},"unclassified_tokens":0}}
	}`)
	var record UsageRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	event, err := eventFromRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	if event.Detail.LatencyMs != 1250 {
		t.Fatalf("latency = %d ms; want 1250", event.Detail.LatencyMs)
	}
	if event.Detail.Tokens.TotalTokens != 130 || !event.Detail.TokenBreakdown.valid() {
		t.Fatalf("canonical accounting was lost: %+v", event.Detail)
	}
	if event.Detail.TokenBreakdown.Input.UncachedTokens != 50 || event.Detail.TokenBreakdown.Output.NonReasoningTokens != 18 {
		t.Fatalf("cache/reasoning subsets were double counted: %+v", event.Detail.TokenBreakdown)
	}
	if event.Detail.RawTokens.CachedTokens != 40 || event.Detail.RawTokens.ReasoningTokens != 12 {
		t.Fatalf("original token counters were lost: %+v", event.Detail.RawTokens)
	}
	if event.Detail.LegacyAccounting {
		t.Fatal("live host records must not use legacy billing semantics")
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{record.APIKey, record.Source, record.AuthIndex} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("sanitized event contains credential %q", secret)
		}
	}
}

func TestIdenticalLiveEventsKeepIndependentIDs(t *testing.T) {
	r := UsageRecord{Model: "model", APIKey: "key", RequestedAt: time.Unix(1, 0)}
	first, err := eventFromRecord(r)
	if err != nil {
		t.Fatal(err)
	}
	second, err := eventFromRecord(r)
	if err != nil {
		t.Fatal(err)
	}
	if first.Detail.EventID == second.Detail.EventID {
		t.Fatal("identical real requests would be deduplicated")
	}
	if first.API != second.API || first.Detail.Source != second.Detail.Source {
		t.Fatal("stable identifiers changed between requests")
	}
	resanitized := sanitizeEvent(first)
	if resanitized.API != first.API || resanitized.Detail.AuthIndex != first.Detail.AuthIndex {
		t.Fatal("export/import sanitization changed an existing identifier")
	}
}

func TestCanonicalBreakdownRejectsOverflowAndFallsBackWithoutGuessing(t *testing.T) {
	b := TokenBreakdown{
		SchemaVersion: 2, Quality: "complete", TotalTokens: 42,
		Input: TokenInput{TotalTokens: 42, UncachedTokens: math.MaxInt64, CacheReadTokens: math.MaxInt64, CacheWriteTokens: 44},
	}
	if b.valid() {
		t.Fatal("overflowing counters must not be accepted as canonical accounting")
	}
	repaired := normalizedBreakdown(b, TokenStats{InputTokens: 30, OutputTokens: 12, TotalTokens: 42})
	if repaired.Quality != "unclassified" || repaired.TotalTokens != 42 || repaired.UnclassifiedTokens != 42 || !repaired.valid() {
		t.Fatalf("invalid accounting must preserve the authoritative total: %+v", repaired)
	}
}

func TestBillingValidationRejectsInvalidPricesAndTimezone(t *testing.T) {
	tests := []struct {
		name    string
		billing Billing
	}{
		{"timezone", Billing{ResetTimezone: "Mars/Olympus"}},
		{"negative", Billing{ModelPrices: map[string]ModelPrice{"model": {Prompt: -1}}}},
		{"infinity", Billing{ModelPrices: map[string]ModelPrice{"model": {Cache: math.Inf(1)}}}},
		{"nan", Billing{ModelPrices: map[string]ModelPrice{"model": {Completion: math.NaN()}}}},
		{"empty model", Billing{ModelPrices: map[string]ModelPrice{"  ": {}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateBilling(&tt.billing); err == nil {
				t.Fatal("invalid billing settings accepted")
			}
		})
	}
}

func TestRawKeysResemblingOpaqueIdentifiersAreStillHashed(t *testing.T) {
	record := UsageRecord{APIKey: "key-0123456789abcdef01234567", Source: "source-0123456789abcdef01234567", AuthIndex: "credential-0123456789abcdef01234567"}
	event, err := eventFromRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{record.APIKey, record.Source, record.AuthIndex} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("raw value resembling fingerprint leaked: %s", secret)
		}
	}
}
