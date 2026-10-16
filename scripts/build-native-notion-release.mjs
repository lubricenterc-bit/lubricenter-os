import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const files=[
 'supabase/migrations/20261013224000_native_catalog_cutover.sql',
 'supabase/migrations/20261013224500_native_catalog_editing.sql',
 'supabase/migrations/20261013225000_catalog_invoice_intake.sql',
 'scripts/native-catalog-notion-rates.sql',
 'supabase/migrations/20261015214500_purchase_receipt_idempotency.sql',
];
const tables=['products','inventory_items','inventory_movements','exchange_rates','supplier_invoices','supplier_receipts','supplier_receipt_items','account_movements'];
const digest='select jsonb_build_object('+tables.map(table=>`'${table}',(select md5(coalesce(jsonb_agg(to_jsonb(t)${table==='products'?"-'catalog_source'-'updated_at'":table==='supplier_receipt_items'?"-'average_cost_before'-'average_cost_after'-'quantity_before'":''} order by id),'[]'::jsonb)::text) from public.${table} t)`).join(',')+",'effective_rates',(select to_jsonb(r) from public.current_exchange_rates r)) as value";
const sql=`-- Coordinated release: catalog and purchasing, both rates retained in Notion.
begin;
set local lock_timeout='3s';
select pg_advisory_xact_lock(hashtextextended('lubricenter-notion-pricing',0));
lock table ${tables.map(t=>'public.'+t).join(',')} in share row exclusive mode nowait;
create temporary table release_integrity_before on commit drop as ${digest};
${files.map(file=>'-- '+file+'\n'+readFileSync(file,'utf8')).join('\n\n')}
do $verify$ declare current_integrity jsonb;begin
 ${digest.replace(' as value',' into current_integrity')};
 if current_integrity is distinct from (select value from release_integrity_before) then
  raise exception 'La entrega cambió datos operativos; se revierte la transacción';
 end if;
 if public.exchange_rate_authority()<>'NOTION' then raise exception 'Las tasas deben conservar Notion';end if;
 perform public.assert_notion_pricing_fresh();
end $verify$;
commit;
`;
if(process.argv.includes('--stdout'))process.stdout.write(sql);
else{mkdirSync('.tmp',{recursive:true});const target=process.argv[2]||'.tmp/native-notion-release.sql';writeFileSync(target,sql);console.log(target);}
