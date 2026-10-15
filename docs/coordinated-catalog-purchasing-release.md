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
4. Install the direct-rate migration and control-status migration in an isolated
   environment, deploy `bcv-rate-sync` with JWT verification, and configure Cron
   using `scripts/configure-bcv-cron.sql`. Check an actual HTTP 200 response and
   `bcv_direct.last_verified_at`; a successful cron SQL statement alone is insufficient.
5. Compare the current dated third-party publication against the official BCV page.
   Save the official page evidence and SHA-256, date and value in the private
   `bcv_official_verifications` table. Never manufacture verification evidence from
   the third-party response. The cutover refuses to run without this evidence.
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

## Current operational block

At the start of this session the direct collector and native migrations were not
installed. The official BCV site was unreachable from both retrieval paths, so
the external rate could not be certified against the official dated publication.
Do not treat successful unit tests or the availability of `bcv.today` as release
approval. Check the current deployment report for final CI and infrastructure state.
