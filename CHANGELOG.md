# Changelog

## 0.1.3 — 2026-09-10

- Move the plugin to its own `Nerva05251228/cpa-usage-statistics` repository, with source and registry at the root.
- Add persistent request-detail column visibility settings, a Show all action, and protection against hiding every available column. Exports retain all fields.
- Rebuilt and deployed without running tests, as requested.

## 0.1.2 — 2026-09-10

- Keep request-detail cells wide enough for single-line client Key masks and credential identifiers, with horizontal scrolling instead of text overlapping adjacent columns.

## 0.1.1 — 2026-09-10

- Resolve stored client Key fingerprints against the current CPA Key configuration and display the actual Key mask in API details and request client sources.
- Keep aggregation and row expansion keyed by stable identities when two Keys share the same mask. Existing history requires no database migration.
- Label removed or unmatched Keys explicitly instead of masking a fingerprint as if it were a credential.
- Add a read-only management bridge catalog that sends only fingerprints and masks; raw Keys stay in the parent management session. Requires the updated management integration patch.
- Include `client_key_id` alongside the display label in request CSV/JSON downloads. Full usage backups retain their existing format.

## 0.1.0 — 2026-09-10

Initial standalone usage statistics plugin with SQLite persistence, usage charts, pricing, import/export, and the CPA sidebar entry.
