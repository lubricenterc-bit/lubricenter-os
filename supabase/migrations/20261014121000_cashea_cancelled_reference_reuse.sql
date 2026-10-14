-- Hotfix: a Cashea reference from an internally CANCELLED sale may be reused
-- for the SAME customer and vehicle. Keep the canceled record as evidence.
-- Never allow two active sales to own the same Cashea reference.
CREATE OR REPLACE FUNCTION lubricenter_private.finance_reference_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_prior_sale_id uuid;
BEGIN
  IF tg_table_name = 'payments' THEN
    IF new.method IN ('TRANSFER_BDV','TRANSFER_BNC','MOBILE_PAYMENT')
       AND coalesce(btrim(new.reference),'') !~ '^\d{4,32}$' THEN
      RAISE EXCEPTION 'Escribe al menos los últimos 4 números de la referencia bancaria';
    END IF;
    IF new.amount_original >= 'Infinity'::numeric THEN
      RAISE EXCEPTION 'Monto inválido';
    END IF;
  ELSE
    IF coalesce(btrim(new.cashea_reference),'') !~ '^\d{1,32}$' THEN
      RAISE EXCEPTION 'Escribe el número de orden Cashea';
    END IF;
    new.cashea_reference := btrim(new.cashea_reference);
    PERFORM pg_advisory_xact_lock(hashtextextended(new.cashea_reference,22));

    -- All competing registrations must be cancelled AND tied to the same
    -- concrete customer+vehicle; customerless/walk-in orders cannot reuse.
    IF EXISTS (
      SELECT 1
      FROM public.cashea_sales previous
      JOIN public.orders old_order ON old_order.id=previous.order_id
      JOIN public.orders new_order ON new_order.id=new.order_id
      WHERE btrim(previous.cashea_reference)=new.cashea_reference
        AND previous.id IS DISTINCT FROM new.id
        AND NOT (
          previous.status='CANCELLED'
          AND old_order.status='CANCELLED'
          AND old_order.customer_id IS NOT NULL
          AND old_order.customer_id = new_order.customer_id
          AND old_order.vehicle_id IS NOT NULL
          AND old_order.vehicle_id = new_order.vehicle_id
        )
    ) THEN
      RAISE EXCEPTION 'Este número de orden Cashea ya está vinculado a una venta activa o de otro cliente o vehículo';
    END IF;

    IF tg_op='INSERT' OR
       (tg_op='UPDATE' AND
        (old.cashea_reference IS DISTINCT FROM new.cashea_reference
         OR old.order_id IS DISTINCT FROM new.order_id)) THEN
      SELECT previous.id INTO v_prior_sale_id
      FROM public.cashea_sales previous
      JOIN public.orders old_order ON old_order.id=previous.order_id
      JOIN public.orders new_order ON new_order.id=new.order_id
      WHERE btrim(previous.cashea_reference)=new.cashea_reference
        AND previous.id IS DISTINCT FROM new.id
        AND previous.status='CANCELLED'
        AND old_order.status='CANCELLED'
        AND old_order.customer_id IS NOT NULL
        AND old_order.customer_id=new_order.customer_id
        AND old_order.vehicle_id IS NOT NULL
        AND old_order.vehicle_id=new_order.vehicle_id
      ORDER BY previous.created_at DESC
      LIMIT 1;

      IF v_prior_sale_id IS NOT NULL THEN
        INSERT INTO public.audit_events(event_type,entity_type,entity_id,data)
        VALUES(
          'cashea.reference_reused_after_cancellation',
          'cashea_sale',
          new.id,
          jsonb_build_object(
            'cashea_reference',new.cashea_reference,
            'reused_from_sale_id',v_prior_sale_id,
            'new_order_id',new.order_id,
            'reason','Corrección de orden anulada; conservar ambos registros históricos'
          )
        );
      END IF;
    END IF;
  END IF;
  RETURN new;
END;
$function$;

-- Defense in depth even if a future code path changes a CANCELLED sale
-- to ACTIVE after its reference has been reused.
CREATE UNIQUE INDEX IF NOT EXISTS cashea_sales_active_reference_unique
 ON public.cashea_sales (btrim(cashea_reference))
 WHERE status IN ('ACTIVE','SETTLED') AND cashea_reference IS NOT NULL;
