# Coordinated catalog and purchasing release

This branch consolidates PRs #59, #60, #66 and #67 onto main commit
`aef8aeed10e8ee101ac1e3bcd789e5fed16f888c`. It preserves subsequent CRM,
multivehicle and payroll fixes. No production business data is seeded by tests.

## Release gates

1. Keep the existing production frontend and Notion job running until all gates pass.
2. Verify backups outside Supabase: 78 products, 433 stock references and 514 stock
   movements at the captured point, plus purchase tables, rates, settings and schema.
   The recovery branch is `backup/pre-catalog-purchases-20261015`.
3. Run full tests, typecheck, build and the release integration test. The latter uses
   the structure-only production fixture, actual invoice constraints, VES cost
   conversion, two sites, replay, history, unchanged prices and operator denials.
4. The independent observer migration `20261016143000` and JWT-protected
   `bcv-rate-sync` may run in parallel with the current system. It fetches ONLY
   `https://www.bcv.org.ve/`, validates TLS using the reviewed missing Sectigo
   intermediate, and retains the original HTML, SHA-256, value and Fecha Valor.
   It writes no operational rates until the native bridge is installed.
5. In the isolated release environment, install the direct-rate/status migrations,
   the observer, and `20261016143500_bcv_official_native_bridge.sql` BEFORE native
   cutover. Trigger the collector and verify HTTP 200, its official evidence and
   `bcv_direct.last_verified_at`. The bridge stages the effective-dated rate and
   verification atomically. Then proceed with cutover. The third-party writer is
   revoked. A successful cron SQL statement alone is insufficient.
6. Stage the frontend built from this exact branch against an isolated database;
   test login, role restrictions, quotes, checkout, orders, Cashea and oil changes.
7. Coordinate the production release in a maintenance window. Apply the catalog
   cutover/editing/intake/compatibility migrations together in ONE transaction,
   followed by the receipt migration and this frontend. The old receipt RPC is
   revoked; old browser tabs must refresh before receiving merchandise.
8. Verify current and future BCV value dates, manual operative rate, snapshots,
   catalog UUIDs/prices/photos, stock, receipt history and published commit. Only
   then disable `notion-pricing-sync-15m`. Confirm Railway terminal `SUCCESS`.

The unrelated `20261015210000_restore_verified_bank_residuals.sql` financial report
change carried by #66 requires its separate review; it is not a prerequisite for
activating catalog and purchasing.

## Recovery

Before cutover, the old frontend and Notion retain authority; do not stop that job.
If a migration transaction fails, roll it back without applying later migrations.
After native edits or receipts exist, do not re-enable Notion writes or restore an
old stock snapshot: that would erase legitimate later activity. Keep native
authority, use the matching frontend/backend version, and investigate audit rows.
Restoring backups is a deliberate recovery operation after comparing changes
since capture, not an automatic deployment rollback.

## Cost and receiving behavior

Invoice creation records a payable. Receiving records physical quantities in an
explicit active site and weighted global item costs; paying records the separate
cash movement. Repeating the same receipt UUID returns its original receipt.
Reusing that UUID with different data is rejected. The browser retains unresolved
requests across reloads. Each movement references a unique receipt line.

General invoice taxes, freight and discounts are visible separately; they are not
allocated to unit inventory cost in this release. Existing historical costs are
not reconstructed. Preparing an inventory reference creates no stock movement.

## Parallel observer and n8n

The official TLS chain issue was resolved on 16 October by supplying its missing
Sectigo DV R36 intermediate after verifying its signature against the built-in R46
root. TLS verification remains enabled. The independent observer is deployed and
has captured the official publication. Native cutover and the purchasing/frontend
release remain gated by isolated authenticated acceptance.

`automations/n8n-bcv-official.json` schedules 08:00, 18:00 and 20:00 Caracas, retries
transient errors, verifies the stored official result and provides a protected
test webhook. No secrets are in the workflow. `scripts/install-n8n-bcv.mjs` creates
its two encrypted credentials and a draft without overwriting existing workflows.
It publishes only with `N8N_PUBLISH=true` and unpublishes if the webhook test fails.
It needs authenticated n8n API access, the observer job token and the Supabase anon
JWT. Never give n8n the Supabase service-role key. Railway OAuth exposes variable
names only and does not authenticate to n8n. Do not reset its owner account or
edit its database to get around that boundary.

Run `scripts/configure-bcv-official-watchdog.sql` for a backup at 08:15, 18:15 and
20:15 Caracas; it skips if n8n already recorded a success in the last 30 minutes.
It is the active scheduler until n8n access is available. The old 15-minute script
is retired. Keep the watchdog after n8n activation as recovery for missed runs.
Before enabling n8n schedules, disable Railway application sleeping for that n8n
service and verify an actual successful execution. Do not redeploy the shared
unversioned n8n image just to import a workflow.

An official-site or parsing failure records an error and preserves the last valid
publication; it never falls back to another provider or updates the operative rate.
