# Daily management report

`/finance` opens on today in America/Caracas. A single historical day, yesterday,
week, month, 30 days and an explicit range are available. `from`/`to` query
parameters preserve the selection on reload and when sharing the URL. Invalid,
future or over-367-day ranges are rejected. Changing dates clears old results;
failed requests never leave old orders under the new date.

## Sales and classification

The additive `finance_management_report(date,date)` RPC is read-only. Its public
facade is an invoker; the private implementation requires a financial ADMIN or
OWNER. Neither function is available to anon. No new table or financial write is
required. Apply only `scripts/finance-management-report.sql`, not other pending
migrations. The application uses the same report for its headline and currency
detail, keeping collection and bank movement calculations separate.

Closed orders are selected by `coalesce(business_at,closed_at)` with inclusive
Caracas midnight and exclusive next midnight. Open/cancelled orders and Cashea
belonging to another location or lacking confirmed ownership are excluded.

The four mutually exclusive allocations are:

- Cashea: the complete invoice, including its initial, at invoice BCV. An initial
  paid in USD is included here and is not counted again as a direct divisas sale.
- Contado Bs: direct VES payments applied to non-Cashea invoices.
- Divisas: nominal USD direct payments applied to non-Cashea invoices. USDT is
  nominally 1:1. Customer balance used at checkout retains its currency, without
  implying a new cash collection that day.
- Crédito LC: the unpaid original portion of a non-Cashea invoice. Payments
  linked to receivables never reclassify this original sale into cash/divisas.

Mixed sales split their amounts; counts of participating orders cannot be summed.
Payment and item aggregates are computed separately to avoid multiplying totals.
The common total is invoice-BCV equivalents plus nominal direct USD, explicitly
labelled an equivalent, not physical dollars in the bank. Missing invoice BCV or
overpaid invoices prevent a fabricated complete equivalent. They appear as review
warnings. No present-day exchange rate is substituted for a missing historical
snapshot.

## Receivables at cutoff

Customer balances are reconstructed from principal less receivable payments
before the selected next-midnight cutoff. The current outstanding/status PAID is
not used to erase debt that existed before a later payment. Already registered
credits of older dates are included. Cancelled credits are excluded as of their
recorded cancellation time. The VES amount remains the actual debt unit; its USD
display is labelled an invoice-BCV equivalent.

Cashea's recorded balance is separate from customer debt. It uses an opening and
signed ledger events through the selected date, respecting reversal timestamps.
Without an opening it reports null / “Sin apertura”, never a made-up zero or a
guessed receivable. Unreconciled payout/withholding records still require the
existing Cashea balance workflow. Financed sales in the chosen period are shown
separately. Historical queries reflect the currently valid source records; this
is not an immutable signed accounting close.

## Presentation and validation

The report provides an executive total, four channel cards and a proportional
bar, receivables, a linked invoice list, CSV for Excel and print-to-PDF styling.
CSV preserves currency columns and neutralizes spreadsheet formulas in text.
Other financial tools remain under the expandable movement/account section.

The real-SQL disposable fixture covers mixed payments, Cashea USD initial,
historical credit paid later, timezone boundaries, invoice business date,
cancelled/open orders, missing BCV, overpayment, foreign Cashea, recorded balance
cutoffs, empty days, permissions and invalid dates. Chromium uses only
example.supabase.co mocks generated from that fixture; it validates daily/range
selection, shared URL reload, exact rows, CSV/PDF, mobile width and recovery after
a failed date change. No synthetic production sale/payment/receipt is created.

The two report functions are additive. Recovery can remove the new UI without
restoring any financial data. Keep the prior functions and all business rows.
