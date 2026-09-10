# CPA Usage Statistics Plugin

[中文文档](README_CN.md)

`cpa-usage-statistics` **0.1.3** is a standalone native CPA plugin. After installation and activation, a new **使用统计** (Usage Statistics) entry appears in the management center sidebar. The plugin owns its page, event collection, SQLite database, and settings.

## Features

- Usage overview, success/failure counts, latency, RPM/TPM, trends, and request health heatmap.
- Model, API key, and observed credential summaries; filtered request details with CSV/JSON export.
- Request-detail column visibility controls, remembered in this browser, plus a Show all action. At least one available column remains visible; exports still include all fields.
- Disjoint input/cache-read/cache-write/output/reasoning/unclassified token categories.
- Model prices and reporting timezone, with historical usage estimated using current prices.
- SQLite persistence, JSON backup/export, and legacy version 0/1 usage import.
- Chinese, English, Russian, and the management center's theme/language.

The Go module has no dependency on a host source checkout. `web/` builds one HTML file embedded inside the shared library; no separate web server or PostgreSQL is needed.

Client Key labels are resolved by the updated management bridge: the parent page matches current configured Keys to the stored fingerprints and returns only `{keys:[{id,label}]}` through the read-only virtual `GET /client-keys` operation. API Key details and request client sources display the actual Key mask, including for existing history. Removed or unmatched Keys show an unmatched label and a short fingerprint. Full Keys are never forwarded to the iframe or persisted by the plugin. This operation requires the v0.1.3 management integration patch and is not a native plugin HTTP endpoint.

## Host requirements

Use the current CPA v7 native plugin loader and standalone management center **with the accompanying host integrations applied**. Installing the library alone does not add these capabilities to an older host:

1. Public usage-plugin events expose the canonical `TokenBreakdown`.
2. The management center supports the `cpa-plugin-bridge` v1 authenticated request bridge.

The host adaptation patches are provided in `integrations/`. Version 0.1.3 supplies a **Linux amd64** library. Native plugin support must be enabled in the host; the required system C library follows the build environment. Other platforms and the CLIProxyAPIHome page entry point have not been verified for this release.

## Install and open

This repository is public. HTTPS cloning and package downloads require no GitHub token or SSH key. These instructions use the prebuilt Linux amd64 package, so Go and Node.js are not needed. Install `git`, `unzip`, and `sha256sum` first.

### 1. Clone and extract

```bash
git clone https://github.com/Nerva05251228/cpa-usage-statistics.git
cd cpa-usage-statistics/releases/0.1.3
sha256sum -c checksums.txt
# Continue only after verification reports OK.
unzip cpa-usage-statistics_0.1.3_linux_amd64.zip -d unpacked
```

If already cloned, enter `releases/0.1.3` from the repository root and run verification and extraction.

### 2. Install the library

Replace `/path/to/CLIProxyAPI` with the host working directory. Adjust the destination if you use a different `plugins.dir`. Before replacing an existing library, stop CPA and back up the old file. Do not overwrite a loaded `.so` in place.

```bash
CPA_DIR=/path/to/CLIProxyAPI
install -Dm755 unpacked/cpa-usage-statistics.so \
  "$CPA_DIR/plugins/linux/amd64/cpa-usage-statistics.so"
```

### 3. Configure and enable

Merge this into the host configuration, preserving existing plugin entries. Choose a persistent `data_dir` writable by the host service account:

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    cpa-usage-statistics:
      enabled: true
      data_dir: "/var/lib/cpa/cpa-usage-statistics"
      retention_days: 0
```

Start or restart CPA, then refresh the management center. For PM2 deployments with a process named `cli-proxy-api`:

```bash
pm2 restart cli-proxy-api
```

Use your deployment's service manager otherwise. Open **使用统计** in the left sidebar. Make a model request and refresh the page to confirm collection. Use **Show columns** in request details to hide columns; this browser remembers the selection. Disabling the plugin hides its sidebar entry.

If the sidebar entry is missing, check the global plugin switch, plugin activation, installation path, and host loading logs. If the page cannot connect to the management center, confirm the backend and panel include the [host integrations](integrations/README.md) and open the page from the sidebar rather than its static resource URL.

| Setting | Default | Behavior |
| --- | --- | --- |
| `enabled` | `false` | Also requires global `plugins.enabled: true` |
| `data_dir` | `data/cpa-usage-statistics` | Relative to the host working directory; keep it stable across upgrades |
| `retention_days` | `0` | Zero retains all events; positive values prune on startup and hourly |

The independent data directory is not deleted when the library is upgraded or stopped. Use page export for backups, or stop the host/use SQLite online backup before copying database files so WAL data is included.

## Data semantics and migration

Counts represent **host usage events**. Retries or additional model metering can produce multiple events for one HTTP request. Collection begins when the plugin is enabled; production history is not stored in the source repository.

Import a legacy version 0/1 `/usage/export` JSON through the page. Imports rebuild totals from details and deduplicate repeat imports. Old exports lacking billing settings require prices and timezone to be configured separately. This plugin's exports include its billing settings. Imported records without reliable canonical categories retain their raw fields and a legacy-accounting marker; the page can show approximate legacy token/cost figures marked `≈`. This does not recover missing cache read/write information. Unknown categories in live events remain unclassified.

Prices are per million tokens and apply to historical events at the current configured rate. Missing prices, unclassified tokens, and cache writes without a dedicated price result in incomplete estimates. Historical fixed-price billing and API key daily spending enforcement are not implemented.

API keys, source identities, and credential identifiers are stored as stable fingerprints. Credential summaries show observed identifiers; old display-name annotations are not migrated automatically. This first release uses a complete compatibility snapshot and browser aggregation. The detail table uses client-side pagination with 100 rows per page, allowing all matching events to be viewed; export covers matching events. Backend pagination parameters exist, but the page does not yet use server pagination/aggregation for large datasets.

A 4096-entry memory queue feeds SQLite. The `health` endpoint exposes queue, drop, and write-error information. A process crash can lose events that have not been committed, so cost totals are estimates.

## Authentication and APIs

`/v0/resource/plugins/cpa-usage-statistics/index.html` serves only the static application. APIs under `/v0/management/plugins/cpa-usage-statistics/` require host management authentication. The parent management page makes allowlisted requests on the iframe's behalf; no management key is passed to the iframe or placed in its URL. Opening the static URL directly shows a connection message; use the sidebar entry.

| Method | Relative endpoint | Purpose |
| --- | --- | --- |
| `GET` | `usage` | Compatibility snapshot; time/API/model/status filters and `page`/`page_size`/`details` |
| `GET` | `usage/export` | Usage JSON with prices/timezone |
| `POST` | `usage/import` | Version 0/1 JSON import |
| `GET`, `PUT` | `billing` | Model prices and reporting timezone |
| `GET` | `sources` | Observed identifiers |
| `GET` | `health` | Queue and storage status |

## Build and package independently

Requirements: Linux amd64, **Go 1.26+**, a C compiler, **Node.js 22.12+**, npm, and **Python 3.10+**. Go's automatic toolchain selection is supported.

```bash
python3 scripts/build.py --test
python3 scripts/package_release.py
python3 scripts/generate_registry.py
```

The build runs `npm ci` and `npm run build` in `web/`, then builds the library with `CGO_ENABLED=1 go build -buildmode=c-shared`. `--test` runs frontend and Go tests; `--skip-web` reuses an already built single-file frontend; `--go /path/to/go` selects a Go executable. `make` runs the build, packaging, and registry generation pipeline.

Outputs:

```text
dist/cpa-usage-statistics.so
dist/build-info.json
dist/THIRD_PARTY_LICENSES.txt
releases/0.1.3/cpa-usage-statistics_0.1.3_linux_amd64.zip
releases/0.1.3/checksums.txt
registry.json
```

The ZIP contains one root-level library plus documentation, build metadata, and license notices. Checksums come from the actual ZIP; the registry advertises only the packaged Linux amd64 platform.

## GitHub distribution

The plugin has its own repository, `Nerva05251228/cpa-usage-statistics`; its source, build scripts and registry live at the repository root. Source, integration patches, ZIP, checksums, and registry are versioned under the immutable `v0.1.3` Git tag. This uses the store's schema-v2 `direct` installation mode and does not require the GitHub Release API.

**This repository is now public.** Follow the manual installation above; no plugin-store configuration or download credentials are required. Public source and packages do not change runtime API authentication: statistics still require CPA management authentication.

Use the README on `main` for current installation instructions. The published `v0.1.3` tag and ZIP remain unchanged; their bundled documentation and registry retain the private-repository description from publication time. This does not prevent public downloads or manual installation.

Use `--repository`, `--ref`, and `--plugin-path` when generating a registry for another location. Use `--public` only for a publicly readable repository. For an update, create a new version/tag and checksums, then update the store source; do not replace published tag contents.

## License

MIT. The original statistics page derives from MIT-licensed work by Luis Pater and Router-For.ME, including the `Nerva05251228/CPA` customization. Original notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Release archives also include dependency license notices collected at build time.
