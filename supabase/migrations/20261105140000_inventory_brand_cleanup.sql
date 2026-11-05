-- F6-a · Unificación de marcas aprobada por el dueño (5 nov 2026).
-- Solo cambia inventory_items.brand en las filas listadas y deja un
-- audit_events por grupo con el antes y el después. No borra nada.
-- La lista de marcas sigue saliendo de los artículos (purchasing_brands);
-- supplier_brands guarda brand_key, que no cambia con mayúsculas.
do $$
declare
  v_group record;
  v_ids uuid[];
  v_before jsonb;
begin
  for v_group in
    select * from (values
      ('Fanfaro',  array['FANFARO'],      null::uuid[]),
      ('Lirax',    array['LIRAX'],        null::uuid[]),
      ('Millard',  array['MILLARD'],      null::uuid[]),
      ('Vega',     array['VEGA'],         null::uuid[]),
      ('Voltex',   array['VOLTEX'],       null::uuid[]),
      -- «FILTRO» y «REFRIGERANTE» no son marcas: el artículo dice cuál es.
      ('Qualid',   array['FILTRO','REFRIGERANTE'],
                   array['a840bf9d-5b5e-49f1-845a-f0cbb0f29e3c','ba39d441-6720-4339-b111-6f4bedd0b9b0']::uuid[]),
      ('Servilub', array['REFRIGERANTE'],
                   array['11ded21a-51a6-424a-9e9b-74c72863187c']::uuid[])
    ) as g(target, sources, only_ids)
  loop
    select coalesce(array_agg(i.id order by i.sku), '{}'),
           coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'sku', i.sku, 'brand', i.brand) order by i.sku), '[]')
      into v_ids, v_before
    from public.inventory_items i
    where i.brand = any(v_group.sources)
      and i.brand is distinct from v_group.target
      and (v_group.only_ids is null or i.id = any(v_group.only_ids));

    if cardinality(v_ids) = 0 then continue; end if;

    update public.inventory_items set brand = v_group.target, updated_at = now()
    where id = any(v_ids);

    insert into public.audit_events(event_type, entity_type, entity_id, data)
    values ('inventory.brand_unified', 'inventory_brand', null,
      jsonb_build_object('brand', v_group.target, 'brand_key', lubricenter_private.brand_key(v_group.target),
        'items', cardinality(v_ids), 'before', v_before, 'after', v_group.target,
        'source', 'migration inventory_brand_cleanup'));
  end loop;
end $$;
