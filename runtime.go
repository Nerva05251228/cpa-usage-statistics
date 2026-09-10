package main

import (
	"embed"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed web/dist/index.html
var assets embed.FS

type Config struct {
	Enabled       bool   `yaml:"enabled"`
	DataDir       string `yaml:"data_dir"`
	RetentionDays int    `yaml:"retention_days"`
}
type Runtime struct {
	mu     sync.RWMutex
	store  *Store
	config Config
}

var runtimeInstance Runtime

func (p *Runtime) configure(configYAML []byte) error {
	cfg := Config{DataDir: "data/cpa-usage-statistics"}
	if len(configYAML) > 0 {
		if err := yaml.Unmarshal(configYAML, &cfg); err != nil {
			return errors.New("invalid plugin configuration")
		}
	}
	if strings.TrimSpace(cfg.DataDir) == "" {
		cfg.DataDir = "data/cpa-usage-statistics"
	}
	cfg.DataDir = filepath.Clean(cfg.DataDir)
	if cfg.RetentionDays < 0 || cfg.RetentionDays > 36500 {
		return errors.New("retention_days must be between 0 and 36500")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.store != nil && cfg == p.config {
		return nil
	}
	// Build the replacement before closing the old store, so errors leave a working instance.
	var next *Store
	if cfg.Enabled {
		var err error
		next, err = openStore(cfg.DataDir, cfg.RetentionDays)
		if err != nil {
			return err
		}
	}
	old := p.store
	p.store = next
	p.config = cfg
	if old != nil {
		return old.close()
	}
	return nil
}
func (p *Runtime) shutdown() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.store == nil {
		return nil
	}
	old := p.store
	p.store = nil
	p.config.Enabled = false
	return old.close()
}
func registration() any {
	return map[string]any{
		"schema_version": 6,
		"metadata": map[string]any{"Name": pluginID, "Version": pluginVersion, "Author": "Nerva05251228", "GitHubRepository": "https://github.com/Nerva05251228/cpa-usage-statistics", "Logo": "", "ConfigFields": []map[string]string{
			{"Name": "data_dir", "Type": "string", "Description": "持久化目录，默认 data/cpa-usage-statistics；升级时请保持此路径不变"},
			{"Name": "retention_days", "Type": "integer", "Description": "保留最近多少天的记录，0 表示永久保留"},
		}},
		"capabilities": map[string]bool{"usage_plugin": true, "management_api": true},
	}
}
func managementRegistration() any {
	var routes []map[string]string
	for _, path := range []string{"usage", "usage/export", "billing", "health", "sources"} {
		routes = append(routes, map[string]string{"Method": "GET", "Path": "/plugins/" + pluginID + "/" + path})
	}
	routes = append(routes, map[string]string{"Method": "POST", "Path": "/plugins/" + pluginID + "/usage/import"}, map[string]string{"Method": "PUT", "Path": "/plugins/" + pluginID + "/billing"})
	return map[string]any{"routes": routes, "resources": []map[string]string{{"Path": "index.html", "Menu": "使用统计", "Description": "请求趋势、Token 用量、健康状态、模型费用和历史明细"}}}
}
func (p *Runtime) handleMethod(method string, raw []byte) (any, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req struct {
			ConfigYAML    []byte `json:"config_yaml"`
			SchemaVersion int    `json:"schema_version"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &req); err != nil {
				return nil, errors.New("invalid lifecycle request")
			}
		}
		if err := p.configure(req.ConfigYAML); err != nil {
			return nil, err
		}
		return registration(), nil
	case "plugin.quiesce":
		return map[string]any{}, p.shutdown()
	case "management.register":
		return managementRegistration(), nil
	case "management.handle":
		var req ManagementRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, errors.New("invalid management request")
		}
		return p.handleManagement(req), nil
	case "usage.handle":
		var record UsageRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, errors.New("invalid usage record")
		}
		p.mu.RLock()
		defer p.mu.RUnlock()
		if p.store == nil {
			return map[string]any{}, nil
		}
		return map[string]any{}, p.store.enqueue(record)
	default:
		return nil, errors.New("unsupported plugin RPC method")
	}
}
func (p *Runtime) handleManagement(req ManagementRequest) ManagementResponse {
	if req.Method == http.MethodGet && req.Path == resourcePath {
		html, err := assets.ReadFile("web/dist/index.html")
		if err != nil {
			return jsonResponse(500, map[string]string{"error": "statistics page unavailable"})
		}
		return ManagementResponse{StatusCode: 200, Headers: http.Header{"Content-Type": {"text/html; charset=utf-8"}, "Cache-Control": {"no-cache"}, "X-Content-Type-Options": {"nosniff"}}, Body: html}
	}
	// Only explicit management routes can return private data. Resource requests never enter this branch.
	path := strings.TrimPrefix(req.Path, apiBase)
	if path == req.Path {
		return jsonResponse(404, map[string]string{"error": "not found"})
	}
	allowed := map[string]bool{"GET /usage": true, "GET /usage/export": true, "POST /usage/import": true, "GET /billing": true, "PUT /billing": true, "GET /health": true, "GET /sources": true}
	if !allowed[req.Method+" "+path] {
		return jsonResponse(404, map[string]string{"error": "not found"})
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	s := p.store
	if s == nil {
		return jsonResponse(503, map[string]string{"error": "statistics plugin is disabled"})
	}
	switch req.Method + " " + path {
	case "GET /usage", "GET /usage/export":
		query := req.Query
		if path == "/usage/export" {
			query = nil
		}
		snap, err := s.snapshot(query)
		if err != nil {
			return jsonResponse(400, map[string]string{"error": err.Error()})
		}
		if path == "/usage/export" {
			billing, errBilling := s.billing()
			if errBilling != nil {
				return jsonResponse(500, map[string]string{"error": "billing unavailable"})
			}
			return jsonResponse(200, map[string]any{"version": 1, "exported_at": time.Now().UTC(), "usage": snap, "billing": billing})
		}
		response := map[string]any{"usage": snap, "failed_requests": snap.FailureCount}
		if size, page, _ := pagination(query); size > 0 {
			response["pagination"] = map[string]any{"page": page, "page_size": size, "total": snap.TotalRequests}
		}
		return jsonResponse(200, response)
	case "POST /usage/import":
		imported, err := s.importUsage(req.Body)
		if err != nil {
			return jsonResponse(400, map[string]string{"error": err.Error()})
		}
		return jsonResponse(200, imported)
	case "GET /billing":
		b, err := s.billing()
		if err != nil {
			return jsonResponse(500, map[string]string{"error": "billing unavailable"})
		}
		return jsonResponse(200, b)
	case "PUT /billing":
		if len(req.Body) > 2<<20 {
			return jsonResponse(413, map[string]string{"error": "billing exceeds 2 MiB"})
		}
		var body Billing
		var wrapper struct {
			Billing *Billing `json:"billing"`
		}
		if err := json.Unmarshal(req.Body, &wrapper); err != nil {
			return jsonResponse(400, map[string]string{"error": "invalid billing JSON"})
		}
		if wrapper.Billing != nil {
			body = *wrapper.Billing
		} else if err := json.Unmarshal(req.Body, &body); err != nil {
			return jsonResponse(400, map[string]string{"error": "invalid billing JSON"})
		}
		if err := s.saveBilling(body); err != nil {
			return jsonResponse(400, map[string]string{"error": err.Error()})
		}
		return jsonResponse(200, map[string]any{"status": "ok"})
	case "GET /health":
		var total int64
		if err := s.db.QueryRow("SELECT COUNT(*) FROM events").Scan(&total); err != nil {
			return jsonResponse(500, map[string]string{"error": "statistics database unavailable"})
		}
		status := "ok"
		if s.errorStatus() != "" || s.dropped.Load() > 0 {
			status = "degraded"
		}
		return jsonResponse(200, map[string]any{"status": status, "version": pluginVersion, "total_requests": total, "queue_depth": len(s.queue), "dropped_records": s.dropped.Load(), "last_error": s.errorStatus(), "retention_days": s.retentionDays})
	case "GET /sources":
		sources, err := s.sources()
		if err != nil {
			return jsonResponse(500, map[string]string{"error": "sources unavailable"})
		}
		return jsonResponse(200, map[string]any{"sources": sources, "mode": "observed"})
	}
	return jsonResponse(404, map[string]string{"error": "not found"})
}
