# CPA host integration

The plugin is a standalone Go module. These small patches add the host-side
capabilities used by its management page; they do not add the statistics page
or database to the host application.

Apply `backend-token-accounting.patch` in a CLIProxyAPI v7 checkout, and
`management-plugin-bridge.patch` in the management-center checkout. The exact
tested base commits are recorded in `manifest.json`. Both patches have been
checked against clean checkouts of those commits.

```bash
# Run in the CLIProxyAPI v7 checkout.
git apply --check /path/to/cpa-usage-statistics/integrations/backend-token-accounting.patch
git apply /path/to/cpa-usage-statistics/integrations/backend-token-accounting.patch
go build -o cli-proxy-api ./cmd/server

# Run in the current management-center checkout.
git apply --check /path/to/cpa-usage-statistics/integrations/management-plugin-bridge.patch
git apply /path/to/cpa-usage-statistics/integrations/management-plugin-bridge.patch
bun install --frozen-lockfile
bun run verify
```

Deploy the rebuilt backend and the management center's `dist/index.html` as
`static/management.html`. Preserve the custom panel by setting
`remote-management.disable-auto-update-panel: true` until a panel release
containing this bridge is selected as the update source. Existing request
credentials and provider configuration do not need to change.

The sibling application directories in the private CPA snapshot repository are
older v6/v1.7 sources. These patches target the newer v7/current-management
checkouts listed in the manifest, not those older snapshot directories.

The backend patch exposes canonical token accounting as an additive field.
The frontend patch passes only approved plugin requests through the existing
management API client; the plugin iframe never receives the management key.
Menus still come from the plugin's own registration and disappear when it is
disabled.

The v0.1.1 frontend integration adds the virtual read-only `/client-keys` catalog.
Only SHA256 identities and Key masks are sent to the plugin. The patch includes
the pinned browser-compatible hash dependency and its Bun lockfile changes.
When upgrading from v0.1.0, rebuild the panel with the updated integration;
the full patch is intended for the clean base recorded in `manifest.json`.
