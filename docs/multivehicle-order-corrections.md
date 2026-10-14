# Orders: shared Cashea payment, per-vehicle CRM, and non-financial corrections

**Scope:** PR #62. Compatible with production PR #61 that recovered references from canceled Cashea sales. Does not merge rate PR #59 or native catalog PR #60.

## Design decisions

- The commercial **order** is the single unit of sale, payment and Cashea installment tracking. The main `orders.customer_id` is the **payer**, the main `orders.vehicle_id` is the default vehicle for old orders.
- Each oil change has an individually selected vehicle saved as `order_items.service_vehicle_id`. New product lines added as part of that oil service are tagged to the same vehicle in one database transaction.
- A service may belong to another customer when the payer covers somebody else's vehicle. History and WhatsApp CRM follow the **vehicle's actual owner**, rather than the Cashea payer.
- `service_records` is the maintenance ledger. After closing, there must be one record per individual service line, with its vehicle/odometer/brand/filter/next maintenance, no duplicate on re-read.
- `customer_followups` allows one POST_SERVICE per `(order_id,vehicle_id)`. Regenerating a message retains the vehicle. Already sent messages are immutable and a subsequent correction creates `POST_SERVICE_CORRECTION` for review.
- The receipt and share text show each serviced vehicle, rather than the first car only.

## Safe correction

The administrator now sees **Corregir servicio / CRM sin tocar cobros** for a closed order. This writes only service metadata and the corresponding service record, vehicle maintenance, pending CRM and audit log. It **never** edits order totals, prices, payment references, bank balances, Cashea sales/initials/installments, or inventory movements. It can also add a zero-priced oil service when a completed sale was wrongly registered only as oil and filter products.

A separate *financial correction* workflow already exists; it rebuilds/annuls the original sale, so users must explicitly choose it only when money genuinely changes.

## Validation requirements

1. Verify backoffice snapshots `lubricenter_private.order_service_migration_backups` (function definitions and CRM messages) were created before replacing triggers.
2. Close a test sale for two vehicles from **different customer records**, one single payment/Cashea, and verify exactly two maintenance records and two CRM messages with the correct owner, plate, odometer and next maintenance.
3. Repeat for one customer's two vehicles. Verify sum of product+service lines is correct, and the Cashea `gross_ref`, bank movements and number of payments are unchanged by the CRM split.
4. Convert a closed product-only order to a recognized oil-change service through the admin correction; audit reason and snapshots; verify bank/stock/Cashea/line totals remain unchanged.
5. Mark a prior CRM message SENT; correct the mileage and verify the original remains SENT and the new correction is PENDING.
6. An attempted duplicate service for the same vehicle (without selecting its existing service line) and a nonadmin correction must be rejected atomically.
7. Test legacy orders with one vehicle and no `service_vehicle_id`: those continue to use the original custom WhatsApp template and vehicle history.
8. Check UI `/orders/[id]/oil-change`, `/orders/[id]/correct-service` and printed receipt on desktop/tablet.
9. Run `Multiple vehicles and safe order corrections` workflow and `Frontend desktop UX` workflow. Cash close checks currently have existing unrelated failures and must be reviewed separately.

## Production release and rollback

Deploy database migrations in order *before* the frontend and verify functions/columns and unchanged financial data. A rollback **must not** blindly restore the original `customer_followups` unique constraint if new multi-vehicle records have since been created. Preserve any new service records and followups. Correct after a dry-run reconciles new records, then restore old function definitions from the private backup snapshot if necessary.

Do not downgrade the service/CRM model without an explicit post-cutover data-mapping strategy. Under no circumstances erase or merge two genuine vehicle histories merely to make the previous unique constraint fit.

## Known limits

- This is service-data correction, not a free-form editor for closed financial lines. Those remain protected by existing finance correction controls.
- Buyer and beneficiary may differ; confirm recipient's WhatsApp before sending manually.
- Automatic inbound Cashea data retrieval is not part of this change. It records a single manually confirmed Cashea transaction.
- The catalog/tasas migrations are separate and remain pending.
