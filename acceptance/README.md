# Acceptance evidence

## v0.1.3 — standalone repository and column visibility

Source and release metadata now target `Nerva05251228/cpa-usage-statistics`.
Tests and browser automation were intentionally skipped for this release at the user's request. Build and deployment status is recorded in `deployment-v0.1.3.json`.
The evidence below describes earlier versions; it is not a test report for v0.1.3.

## v0.1.2 — recognizable client Key display

Validated on 2026-09-10 with the final Linux amd64 ZIP, SHA256
`6f564b441176012e04d192bf53ec9887d3b1f7101da36aca8a41ec395140241c`.

- `live-client-key-labels` and `staging-client-key-labels` JSON/PNG pairs confirm API Key details and request client sources show configured Key masks for existing history. Browser messages contain neither raw client Keys nor the management credential. Request cells stay on one line without overlapping adjacent columns; the table scrolls horizontally.
- `key-labels-*-final-package.json` confirms the final package upgrade preserves existing events. `key-labels-*-upgrade.json` records the earlier v0.1.0 to v0.1.1 rollout.
- `reported-key-event.json` confirms the reported historical record belongs to the same configured client Key.
- Host frontend: 461 tests / 1550 assertions, lint, type check and single-file build passed. Plugin frontend: 22 tests and build passed. The final CSS adjustment was checked in the real browser on staging and live.

In staging, replacing the same library path and reloading unchanged configuration did not activate the new version. The verified upgrades use a normal CPA process restart and preserve the separate SQLite data directory.

## v0.1.0 — initial integration

The original package is archived in `Nerva05251228/CPA` under
`plugins/cpa-usage-statistics/releases/0.1.0/`, SHA256
`2f23b4c874da9dc9e34b05638586f4c9cfe6ce44b8cd2a9f03463c8c08300932`.

- `live-sidebar.png`, `live-browser.json`, `staging-sidebar.png`, and `staging-browser.json`: initial sidebar and page acceptance.
- `staging-api.json`: isolated regular, streamed, and failed HTTP calls; canonical token categories; management authentication; billing persistence; and export/import deduplication.
- `staging-lifecycle.json` and `staging-restart.json`: sidebar follows enable/disable, and stored events survive disable/re-enable and full process restart.
- `store-install.json`: authenticated loopback registry installation of the final v0.1.0 ZIP, rejection of an incorrect checksum, and automatic installation/activation.
- Initial validation also passed plugin backend 18 tests and race checks, targeted host Go tests, and host compilation.

The historical store fixture verifies installer authentication, not GitHub repository visibility. The standalone plugin repository is now public; HTTPS cloning and manual package downloads require no GitHub credentials. See the current main README for installation instructions.

No raw client or management Keys, production configuration, databases, or upstream responses are published. Screenshots show the deployed UI; credentials are masked or represented by stable fingerprints.
