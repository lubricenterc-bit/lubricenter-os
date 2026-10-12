
-- Separate BNC imported evidence from Cashea receivables and other cash movements.
-- Bank statement days do not have a time: use date-only precision in raw; never imply an actual hour.
ALTER TABLE public.external_sources DROP CONSTRAINT IF EXISTS external_sources_provider_check;
ALTER TABLE public.external_sources ADD CONSTRAINT external_sources_provider_check
  CHECK (provider IN ('BDV','BNC','CASHEA_TRANSACTIONS','CASHEA_ORDERS'));
ALTER TABLE public.external_sources DROP CONSTRAINT IF EXISTS external_sources_check;
ALTER TABLE public.external_sources ADD CONSTRAINT external_sources_check
  CHECK (provider NOT IN ('BDV','BNC') OR account_id IS NOT NULL);
INSERT INTO public.external_sources(provider,name,account_id,external_account,currency,active)
SELECT 'BNC','BNC · cuenta Cashea · movimientos bancarios',id,'BNC',currency,true
FROM public.financial_accounts WHERE code='BNC' AND currency='VES'
ON CONFLICT(provider,external_account) DO NOTHING;

CREATE OR REPLACE FUNCTION lubricenter_private.finance_import(p_source_id uuid, p_name text, p_from date, p_to date, p_preview jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.external_sources; b uuid; t uuid; r jsonb; v_key text; v_fp text; v_own text; v_reason text; v_matches integer; v_sale uuid; v_bad boolean; v_time timestamptz;
begin
 perform lubricenter_private.finance_require();
 select * into s from public.external_sources where id=p_source_id and active for update;
 if not found then raise exception 'Fuente no disponible'; end if;
 if s.provider<>p_preview->>'provider' then raise exception 'Reporte incompatible con la fuente'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Selecciona un período válido, máximo un año'; end if;
 if jsonb_typeof(p_preview->'rows')<>'array' or jsonb_typeof(p_preview->'orders')<>'array' or jsonb_typeof(p_preview->'errors')<>'array' then raise exception 'Formato del reporte inválido'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')>10000 then raise exception 'Importa hasta 10000 filas por lote'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')=0 then raise exception 'El reporte está vacío'; end if;
 v_fp:=md5(jsonb_build_object('from',p_from,'to',p_to,'rows',p_preview->'rows','orders',p_preview->'orders','errors',p_preview->'errors')::text);
 select id into b from public.external_import_batches where source_id=s.id and fingerprint=v_fp;
 if b is not null then return b; end if;
 insert into public.external_import_batches(source_id,fingerprint,source_name,requested_from,requested_to,row_count,duplicate_count,balance_chain,validation,payload)
 values(s.id,v_fp,left(p_name,200),p_from,p_to,jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders'),coalesce((p_preview->>'duplicates')::integer,0),null,
 jsonb_build_object('errors',p_preview->'errors','warnings',p_preview->'warnings'),p_preview) returning id into b;
 for r in select value from jsonb_array_elements(p_preview->'rows') loop
  v_time:=(r->>'occurred_at')::timestamptz;
  if s.provider='CASHEA_ORDERS' or coalesce(r->>'reference','')!~'^\d+$' or coalesce(r->>'direction','') not in ('IN','OUT') or (s.provider IN ('BDV','BNC') and r->>'currency'<>s.currency) or (s.provider='CASHEA_TRANSACTIONS' and r->>'currency' not in ('VES','USD')) or (r->>'amount')::numeric is null or (r->>'amount')::numeric<=0 or (r->>'amount')::numeric>='Infinity'::numeric then raise exception 'Movimiento inválido en fila %',r->>'row'; end if;
  if s.provider IN ('BDV','BNC') and (r->>'balance') is null then raise exception 'Falta saldo del banco'; end if;
  if s.provider='CASHEA_TRANSACTIONS' and (coalesce(r->>'external_order','')!~'^\d+$' or (r->>'amount_ref') is null or (r->>'assigned_ref') is null or coalesce(trim(r->>'provider_account'),'')=''  or r->>'direction'<>'IN') then raise exception 'Reporte Cashea: revisa cuenta, orden y montos en fila %',r->>'row'; end if;
  v_key:=md5(jsonb_build_array(v_time,r->>'reference',r->>'direction',(r->>'amount')::numeric,case when s.provider IN ('BDV','BNC') then (r->>'balance')::numeric else null end,coalesce(r->>'provider_account',''))::text);
  v_own:='OWN'; v_reason:='OWN_BANK_ACCOUNT'; v_sale:=null;
  if s.provider='CASHEA_TRANSACTIONS' then
   select count(*),(array_agg(id))[1] into v_matches,v_sale from public.cashea_sales where trim(cashea_reference)=r->>'external_order' and status<>'CANCELLED';
   v_own:=case when v_matches=1 then 'OWN' else 'UNRESOLVED' end; v_reason:=case when v_matches=1 then 'ORDER_MATCH' else 'UNKNOWN' end;
  end if;
  insert into public.external_transactions(source_id,identity_key,first_batch_id,occurred_at,reference,description,direction,currency,amount,balance,amount_ref,assigned_ref,exchange_rate,rate_date,external_order,installments,provider_account,channel_label,ownership_status,ownership_reason,ownership_evidence,raw)
  values(s.id,v_key,b,v_time,r->>'reference',r->>'description',r->>'direction',r->>'currency',(r->>'amount')::numeric,(r->>'balance')::numeric,(r->>'amount_ref')::numeric,(r->>'assigned_ref')::numeric,(r->>'rate')::numeric,(r->>'rate_date')::date,r->>'external_order',array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))),r->>'provider_account',r->>'channel_label',v_own,v_reason,jsonb_build_object('cashea_sale_id',v_sale),r->'raw')
  on conflict(source_id,identity_key) do nothing returning id into t;
  if t is null then
   select id into t from public.external_transactions where source_id=s.id and identity_key=v_key;
   if exists(select 1 from public.external_transactions where id=t and (external_order is distinct from r->>'external_order' or amount_ref is distinct from (r->>'amount_ref')::numeric or assigned_ref is distinct from (r->>'assigned_ref')::numeric or installments is distinct from array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))))) then
    perform lubricenter_private.finance_case('conflict:'||t,'SOURCE_CONFLICT','external_transaction',t,'Reporte con versiones distintas','El mismo cobro aparece con otra orden, cuota o importe. No se duplicó ni sobrescribió.',jsonb_build_object('batch_id',b,'row',r));
   end if;
  end if;
  insert into public.external_batch_transactions values(b,t,(r->>'row')::integer) on conflict do nothing;
  if (r->>'assigned_ref')::numeric-(r->>'amount_ref')::numeric>0.005 then perform lubricenter_private.finance_case('amount:'||t,'SOURCE_AMOUNT','external_transaction',t,'Revisar importe Cashea','Monto asignado supera el USD informado más allá de medio centavo; conserva ambas cifras.',r); end if;
  t:=null;
 end loop;
 for r in select value from jsonb_array_elements(p_preview->'orders') loop
  if s.provider<>'CASHEA_ORDERS' or coalesce(r->>'external_order','')!~'^\d+$' or jsonb_typeof(r->'installments')<>'array' then raise exception 'Snapshot Cashea inválido'; end if;
  insert into public.cashea_order_snapshots(batch_id,external_order,purchased_on,status,total_ref,initial_ref,installments,raw)
  values(b,r->>'external_order',(r->>'purchased_on')::date,r->>'status',(r->>'total_ref')::numeric,(r->>'initial_ref')::numeric,r->'installments',r->'raw');
 end loop;
 update public.external_import_batches set
 observed_from=(select min(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q),
 observed_to=(select max(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q)
 where id=b;
 -- Recalculate chain from persisted decimals; never trust browser's 'complete' or chain flag.
 if s.provider IN ('BDV','BNC') then
  with ordered as (select x.*,lag(balance) over(order by x.occurred_at,case when (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') z limit 1) >= (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') with ordinality a(z,n) order by n desc limit 1) then -l.row_number else l.row_number end) prev from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b)
  select bool_or(prev is not null and balance<>prev+case when direction='IN' then amount else -amount end) into v_bad from ordered;
  update public.external_import_batches set balance_chain=not coalesce(v_bad,false) where id=b;
 end if;
 perform lubricenter_private.finance_case('batch:'||b,'COVERAGE','import_batch',b,'Confirmar cobertura del reporte','La fecha del primer y último movimiento no prueba que estén todas las páginas.',jsonb_build_object('source_name',p_name));
 return b;
end $function$
;

CREATE TABLE IF NOT EXISTS public.finance_bank_cashea_evidence (
 bank_transaction_id uuid PRIMARY KEY REFERENCES public.external_transactions(id) ON DELETE RESTRICT,
 cashea_transaction_id uuid NOT NULL UNIQUE REFERENCES public.external_transactions(id) ON DELETE RESTRICT,
 rule text NOT NULL CHECK (rule IN ('EXACT_REFERENCE_AND_AMOUNT','UNIQUE_SUFFIX_AMOUNT_DATE')),
 amount_ves numeric NOT NULL CHECK (amount_ves>0),
 linked_at timestamptz NOT NULL DEFAULT now(),
 linked_by uuid DEFAULT auth.uid()
);
ALTER TABLE public.finance_bank_cashea_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_bank_cashea_evidence FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.finance_match_bnc_cashea()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $body$
DECLARE v_count integer;v_amount numeric;v_candidates integer;
BEGIN
 PERFORM lubricenter_private.finance_require('OWNER');
 WITH candidate AS (
   SELECT b.id bank_id,c.id cashea_id,b.amount,
     CASE WHEN b.reference=c.reference THEN 'EXACT_REFERENCE_AND_AMOUNT'
       ELSE 'UNIQUE_SUFFIX_AMOUNT_DATE' END rule,
     count(*) over(partition by b.id) nb, count(*) over(partition by c.id) nc
   FROM public.external_transactions b
   JOIN public.external_sources bs ON bs.id=b.source_id AND bs.provider='BNC'
   JOIN public.external_transactions c ON c.direction='IN' AND c.currency='VES'
     AND c.amount=b.amount AND abs(timezone('America/Caracas',b.occurred_at)::date-timezone('America/Caracas',c.occurred_at)::date)<=1
     AND (b.reference=c.reference OR (
         length(regexp_replace(b.reference,'\D','','g'))>=4
         AND length(regexp_replace(c.reference,'\D','','g'))>=4
         AND right(b.reference,4)=right(c.reference,4)))
   JOIN public.external_sources cs ON cs.id=c.source_id AND cs.provider='CASHEA_TRANSACTIONS'
   WHERE b.direction='IN' AND b.currency='VES' AND b.description ILIKE '%Pago Movil%'
 )
 INSERT INTO public.finance_bank_cashea_evidence(bank_transaction_id,cashea_transaction_id,rule,amount_ves)
 SELECT bank_id,cashea_id,rule,amount FROM candidate WHERE nb=1 AND nc=1
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 SELECT count(*),coalesce(sum(amount_ves),0) INTO v_candidates,v_amount
 FROM public.finance_bank_cashea_evidence;
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 SELECT 'finance.bnc_cashea_evidence_batch','external_source',s.id,
   jsonb_build_object('new_links',v_count,'all_links',v_candidates,'total_ves',v_amount,'source','BNC_CASHEA')
 FROM public.external_sources s WHERE s.provider='BNC' LIMIT 1;
 RETURN jsonb_build_object('new',v_count,'total',v_candidates,'matched_ves',v_amount,
   'semantics','Two documents for the same bank inflow; not two revenues. Unmatched Cashea not assigned to Cabudare.');
END $body$;
CREATE OR REPLACE FUNCTION public.finance_match_bnc_cashea()
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $wrapper$
 SELECT lubricenter_private.finance_match_bnc_cashea();
$wrapper$;
REVOKE ALL ON FUNCTION lubricenter_private.finance_match_bnc_cashea() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.finance_match_bnc_cashea() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION lubricenter_private.finance_match_bnc_cashea() TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_match_bnc_cashea() TO authenticated;
