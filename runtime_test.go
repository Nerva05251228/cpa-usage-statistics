package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testRuntime(t *testing.T) (*Runtime, []byte) {
	t.Helper()
	p := &Runtime{}
	config := []byte(fmt.Sprintf("enabled: true\ndata_dir: %q\n", t.TempDir()))
	if err := p.configure(config); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.shutdown(); err != nil {
			t.Errorf("shutdown runtime: %v", err)
		}
	})
	return p, config
}

func sendUsage(t *testing.T, p *Runtime, record UsageRecord) {
	t.Helper()
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.handleMethod("usage.handle", raw); err != nil {
		t.Fatal(err)
	}
}

func runtimeSnapshot(t *testing.T, p *Runtime) StatisticsSnapshot {
	t.Helper()
	response := p.handleManagement(ManagementRequest{Method: http.MethodGet, Path: apiBase + "/usage"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("usage response status=%d body=%s", response.StatusCode, response.Body)
	}
	var payload struct {
		Usage StatisticsSnapshot `json:"usage"`
	}
	if err := json.Unmarshal(response.Body, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Usage
}

func TestPluginRegistersSidebarMenuAndAuthenticatedDataRoutes(t *testing.T) {
	p := &Runtime{}
	result, err := p.handleMethod("management.register", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var registration struct {
		Resources []struct{ Path, Menu string }   `json:"resources"`
		Routes    []struct{ Path, Method string } `json:"routes"`
	}
	if err := json.Unmarshal(raw, &registration); err != nil {
		t.Fatal(err)
	}
	if len(registration.Resources) != 1 || registration.Resources[0].Menu != "使用统计" || registration.Resources[0].Path != "index.html" {
		t.Fatalf("missing usage statistics sidebar resource: %s", raw)
	}
	foundUsage := false
	for _, route := range registration.Routes {
		if route.Path == "/plugins/"+pluginID+"/usage" && route.Method == http.MethodGet {
			foundUsage = true
		}
	}
	if !foundUsage {
		t.Fatalf("usage API is not registered under authenticated management prefix: %s", raw)
	}
}

func TestRuntimeDisabledByDefaultHasNoDatabaseAndServesOnlyStaticResource(t *testing.T) {
	p := &Runtime{}
	dir := filepath.Join(t.TempDir(), "disabled-store")
	if err := p.configure([]byte(fmt.Sprintf("data_dir: %q\n", dir))); err != nil {
		t.Fatal(err)
	}
	defer p.shutdown()
	sendUsage(t, p, UsageRecord{Model: "ignored", APIKey: "sk-should-never-be-recorded", RequestedAt: time.Now()})
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("disabled plugin created storage or failed to inspect it: %v", err)
	}
	response := p.handleManagement(ManagementRequest{Method: http.MethodGet, Path: apiBase + "/usage"})
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("disabled API status = %d; want 503", response.StatusCode)
	}
	response = p.handleManagement(ManagementRequest{Method: http.MethodGet, Path: resourcePath})
	if response.StatusCode != http.StatusOK || response.Headers.Get("Content-Type") != "text/html; charset=utf-8" || len(response.Body) == 0 {
		t.Fatalf("static plugin page unavailable: status=%d headers=%v", response.StatusCode, response.Headers)
	}
	for _, path := range []string{
		"/v0/resource/plugins/" + pluginID + "/usage",
		"/v0/resource/plugins/" + pluginID + "/billing",
		apiBase + "-other/usage", apiBase + "/../usage", apiBase + "/usage/unknown",
	} {
		response := p.handleManagement(ManagementRequest{Method: http.MethodGet, Path: path})
		if response.StatusCode != http.StatusNotFound {
			t.Errorf("unregistered path %q returned %d", path, response.StatusCode)
		}
	}
}

func TestQuiesceFlushesAndReenableRetainsStatistics(t *testing.T) {
	p, config := testRuntime(t)
	sendUsage(t, p, UsageRecord{Model: "retained", RequestedAt: time.Now(), Detail: UsageDetail{TotalTokens: 42}})
	if _, err := p.handleMethod("plugin.quiesce", nil); err != nil {
		t.Fatal(err)
	}
	sendUsage(t, p, UsageRecord{Model: "disabled", RequestedAt: time.Now(), Detail: UsageDetail{TotalTokens: 999}})
	if err := p.configure(config); err != nil {
		t.Fatal(err)
	}
	snapshot := runtimeSnapshot(t, p)
	if snapshot.TotalRequests != 1 || snapshot.TotalTokens != 42 {
		t.Fatalf("disable/enable lost queued data or recorded disabled usage: %+v", snapshot)
	}
}

func TestInvalidReconfigureKeepsWorkingStore(t *testing.T) {
	p, _ := testRuntime(t)
	sendUsage(t, p, UsageRecord{Model: "existing", RequestedAt: time.Now(), Detail: UsageDetail{TotalTokens: 1}})
	for _, config := range []string{"enabled: [", "enabled: true\nretention_days: -1\n", "enabled: true\nretention_days: 36501\n"} {
		if err := p.configure([]byte(config)); err == nil {
			t.Fatalf("invalid config accepted: %q", config)
		}
	}
	sendUsage(t, p, UsageRecord{Model: "still-working", RequestedAt: time.Now(), Detail: UsageDetail{TotalTokens: 2}})
	if snapshot := runtimeSnapshot(t, p); snapshot.TotalRequests != 2 || snapshot.TotalTokens != 3 {
		t.Fatalf("rejected config disrupted the active store: %+v", snapshot)
	}
}

func TestExportIgnoresPaginationAndRoundTripsBillingAndEventIDs(t *testing.T) {
	p, _ := testRuntime(t)
	for i := 0; i < 2; i++ {
		sendUsage(t, p, UsageRecord{APIKey: "private-client-key", Model: "model", RequestedAt: time.Now(), Detail: UsageDetail{TotalTokens: 10}})
	}
	response := p.handleManagement(ManagementRequest{Method: http.MethodPut, Path: apiBase + "/billing", Body: []byte(`{"reset-timezone":"UTC","model-prices":{"model":{"prompt":2,"completion":4,"cache":0.2}}}`)})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("save billing: %d %s", response.StatusCode, response.Body)
	}
	exported := p.handleManagement(ManagementRequest{Method: http.MethodGet, Path: apiBase + "/usage/export", Query: url.Values{"page_size": {"1"}, "page": {"2"}}})
	if exported.StatusCode != http.StatusOK {
		t.Fatalf("export: %d %s", exported.StatusCode, exported.Body)
	}
	var payload struct {
		Usage   StatisticsSnapshot `json:"usage"`
		Billing Billing            `json:"billing"`
	}
	if err := json.Unmarshal(exported.Body, &payload); err != nil {
		t.Fatal(err)
	}
	var details int
	for _, api := range payload.Usage.APIs {
		for _, model := range api.Models {
			details += len(model.Details)
		}
	}
	if payload.Usage.TotalRequests != 2 || details != 2 || payload.Billing.ResetTimezone != "UTC" || payload.Billing.ModelPrices["model"].Cache != 0.2 {
		t.Fatalf("incomplete export: %s", exported.Body)
	}
	imported := p.handleManagement(ManagementRequest{Method: http.MethodPost, Path: apiBase + "/usage/import", Body: exported.Body})
	if imported.StatusCode != http.StatusOK {
		t.Fatalf("import: %d %s", imported.StatusCode, imported.Body)
	}
	var result ImportResult
	if err := json.Unmarshal(imported.Body, &result); err != nil {
		t.Fatal(err)
	}
	if result.Added != 0 || result.Skipped != 2 || result.TotalRequests != 2 {
		t.Fatalf("self import duplicated live events: %+v", result)
	}
}
