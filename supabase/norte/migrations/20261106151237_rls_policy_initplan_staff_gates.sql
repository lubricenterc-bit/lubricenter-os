do $$
declare
  p record;
  fn_re constant text :=
    '(?<!SELECT )lubricenter_private\.(staff_identity_allowed|staff_owner|is_order_admin|finance_role|staff_can)\(((''[^'']*''::text)?)\)';
  new_qual text;
  new_check text;
  sql text;
  changed int := 0;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ fn_re or coalesce(with_check, '') ~ fn_re)
  loop
    new_qual  := regexp_replace(p.qual, fn_re, '(SELECT lubricenter_private.\1(\2))', 'g');
    new_check := regexp_replace(p.with_check, fn_re, '(SELECT lubricenter_private.\1(\2))', 'g');
    sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if p.qual is not null then sql := sql || ' using (' || new_qual || ')'; end if;
    if p.with_check is not null then sql := sql || ' with check (' || new_check || ')'; end if;
    execute sql;
    changed := changed + 1;
  end loop;
  raise notice 'Políticas reescritas: %', changed;
end $$;