-- Historical BNC import and audited one-to-one link between bank credits and Cashea receipts.
ALTER TABLE public.external_sources DROP CONSTRAINT IF EXISTS external_sources_provider_check;
ALTER TABLE public.external_sources ADD CONSTRAINT external_sources_provider_check
CHECK (provider IN ('BDV','BNC','CASHEA_TRANSACTIONS','CASHEA_ORDERS'));
INSERT INTO public.external_sources(provider,name,account_id,external_account,currency,active)
SELECT 'BNC','BNC · movimientos bancarios Cashea',a.id,'BNC_CASHEA','VES',true
FROM public.financial_accounts a WHERE a.code='BNC'
AND NOT EXISTS(SELECT 1 FROM public.external_sources s WHERE s.provider='BNC' AND s.external_account='BNC_CASHEA');

CREATE TABLE IF NOT EXISTS public.finance_external_bank_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 bank_transaction_id uuid NOT NULL UNIQUE REFERENCES public.external_transactions(id),
 cashea_transaction_id uuid NOT NULL UNIQUE REFERENCES public.external_transactions(id),
 link_method text NOT NULL CHECK(link_method IN ('REFERENCE_AMOUNT','SUFFIX_AMOUNT_DATE')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 CHECK (bank_transaction_id<>cashea_transaction_id)
);
ALTER TABLE public.finance_external_bank_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_external_bank_links FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION lubricenter_private.finance_bnc_cashea_link()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$
DECLARE v_new integer:=0;v_total integer:=0;v_fuzzy integer:=0;
BEGIN
 PERFORM lubricenter_private.finance_require();
 WITH candidates AS (
  SELECT b.id bid,c.id cid,
   CASE WHEN ltrim(b.reference,'0')=ltrim(c.reference,'0') THEN 'REFERENCE_AMOUNT'
        ELSE 'SUFFIX_AMOUNT_DATE' END method,
   count(*) OVER (PARTITION BY b.id) bank_candidates,
   count(*) OVER (PARTITION BY c.id) cashea_candidates
  FROM public.external_transactions b
  JOIN public.external_sources bs ON bs.id=b.source_id AND bs.provider='BNC'
  JOIN public.external_transactions c ON c.direction='IN' AND c.currency='VES'
    AND abs(b.amount-c.amount)<=0.01
    AND timezone('America/Caracas',b.occurred_at)::date=timezone('America/Caracas',c.occurred_at)::date
    AND (ltrim(b.reference,'0')=ltrim(c.reference,'0') OR
     (length(b.reference)>=4 AND length(c.reference)>=4 AND right(b.reference,4)=right(c.reference,4)))
  JOIN public.external_sources cs ON cs.id=c.source_id AND cs.provider='CASHEA_TRANSACTIONS'
  WHERE b.direction='IN' AND b.currency='VES' AND b.description ILIKE '%Abono Pago Movil%'
 )
 INSERT INTO public.finance_external_bank_links(bank_transaction_id,cashea_transaction_id,link_method,created_by,evidence)
 SELECT bid,cid,method,auth.uid(),jsonb_build_object('validated_on','amount,day,bank-reference','unique_bank_candidates',bank_candidates,'unique_cashea_candidates',cashea_candidates)
 FROM candidates ca
 WHERE bank_candidates=1 AND cashea_candidates=1
   AND NOT EXISTS (SELECT 1 FROM public.finance_external_bank_links l WHERE l.bank_transaction_id=ca.bid OR l.cashea_transaction_id=ca.cid)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_new=ROW_COUNT;
 SELECT count(*),count(*) FILTER(WHERE link_method='SUFFIX_AMOUNT_DATE') INTO v_total,v_fuzzy FROM public.finance_external_bank_links l
 JOIN public.external_transactions b ON b.id=l.bank_transaction_id
 JOIN public.external_sources s ON s.id=b.source_id AND s.provider='BNC';
 INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
 SELECT 'finance.bnc_cashea_linked','external_transaction',l.bank_transaction_id,
   jsonb_build_object('cashea_transaction_id',l.cashea_transaction_id,'method',l.link_method)
 FROM public.finance_external_bank_links l
 WHERE l.created_by=auth.uid() AND l.created_at>=now()-interval '1 second'
 ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('new_links',v_new,'total_links',v_total,'suffix_links',v_fuzzy);
END $f$;

CREATE OR REPLACE FUNCTION public.finance_bnc_cashea_link()
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $api$
 SELECT lubricenter_private.finance_bnc_cashea_link()
$api$;
REVOKE ALL ON FUNCTION public.finance_bnc_cashea_link() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION lubricenter_private.finance_bnc_cashea_link() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finance_bnc_cashea_link() TO authenticated;
GRANT EXECUTE ON FUNCTION lubricenter_private.finance_bnc_cashea_link() TO authenticated;
