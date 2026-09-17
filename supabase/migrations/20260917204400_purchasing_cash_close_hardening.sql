revoke all on function public.snapshot_order_item_cost() from public,anon,authenticated;
revoke all on function public.mark_cash_close_review() from public,anon,authenticated;

create index if not exists cash_closing_accounts_account_idx on public.cash_closing_accounts(account_id);
create index if not exists cash_closings_location_idx on public.cash_closings(location_id);
create index if not exists supplier_invoice_items_invoice_idx on public.supplier_invoice_items(supplier_invoice_id);
create index if not exists supplier_invoice_items_inventory_idx on public.supplier_invoice_items(inventory_item_id) where inventory_item_id is not null;
create index if not exists supplier_payments_invoice_idx on public.supplier_payments(supplier_invoice_id);
create index if not exists supplier_payments_account_idx on public.supplier_payments(account_id);
create index if not exists supplier_receipts_invoice_idx on public.supplier_receipts(supplier_invoice_id);
create index if not exists supplier_receipts_location_idx on public.supplier_receipts(location_id);
create index if not exists supplier_receipt_items_receipt_idx on public.supplier_receipt_items(supplier_receipt_id);
create index if not exists supplier_receipt_items_invoice_item_idx on public.supplier_receipt_items(supplier_invoice_item_id);
create index if not exists supplier_receipt_items_inventory_idx on public.supplier_receipt_items(inventory_item_id);
