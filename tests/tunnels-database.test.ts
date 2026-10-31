import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261031120000_tunnels_engine.sql', 'utf8');
let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const asUser = (id: string) => db.exec(`select set_config('test.uid','${id}',false)`);
const setPerms = (perms: string) => db.exec(`select set_config('test.perms','${perms}',false)`);
const errorOf = async (sql: string, params: unknown[] = []) => { try { await db.query(sql, params); return null; } catch (e) { return (e as Error).message; } };

// Minimal stand-ins for production objects, plus a toy process ("prueba") with one reversible action.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   create role anon; create role authenticated; create role service_role;
   create schema auth; create schema lubricenter_private;
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
   create function lubricenter_private.staff_identity_allowed() returns boolean language sql stable as $$ select true $$;
   create function lubricenter_private.staff_can(p_key text) returns boolean language sql stable as $$ select coalesce(current_setting('test.perms',true),'*')='*' or p_key=any(string_to_array(current_setting('test.perms',true),',')) $$;
   create function lubricenter_private.staff_owner() returns boolean language sql stable as $$ select auth.uid()='${OWNER}'::uuid $$;
   create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,created_at timestamptz default now());
   create function lubricenter_private.finance_audit() returns trigger language plpgsql as $$ begin insert into public.audit_events(event_type,entity_type) values('finance.'||lower(tg_op),tg_table_name); return coalesce(new,old); end $$;
   create table public.locations(id uuid primary key default gen_random_uuid(),name text,active boolean default true,created_at timestamptz default now());
   insert into public.locations(name) values('Lubricenter Cabudare');
   create table public.staff_permission_catalog(key text primary key,area text,label text,explanation text,recommended boolean,sort_order integer);
  `);
  await db.exec(migration);
  await db.exec(`
   create table public.toy_items(id text primary key,branch text,version integer not null default 1);
   insert into public.toy_items(id,branch) values('a',null),('b',null),('c',null);
   create function lubricenter_private.toy_assign(p jsonb) returns jsonb language plpgsql as $$
   declare v public.toy_items;
   begin
    select * into v from public.toy_items where id=p->>'id' for update;
    if not found then raise exception 'Elemento no encontrado'; end if;
    if p->>'branch'='FALLA' then raise exception 'La sucursal no existe'; end if;
    update public.toy_items set branch=p->>'branch',version=version+1 where id=v.id;
    return jsonb_build_object('id',v.id,'previous',v.branch,'version',v.version+1);
   end $$;
   create function lubricenter_private.toy_unassign(r jsonb) returns void language plpgsql as $$
   begin
    update public.toy_items set branch=r->>'previous',version=version+1 where id=r->>'id' and version=(r->>'version')::int;
    if not found then raise exception 'Otro proceso cambió este elemento; no puedo deshacerlo'; end if;
   end $$;
   insert into lubricenter_private.tunnel_action_handlers(action_type,tunnel_key,apply_fn,revert_fn)
   values('prueba.assign','prueba','lubricenter_private.toy_assign','lubricenter_private.toy_unassign');
  `);
  await asUser(OWNER);
}, 120000);
afterAll(async () => { await db?.close(); });

const assign = (id: string, branch: string) => JSON.stringify({ type: 'prueba.assign', payload: { id, branch }, label: 'Asignar' });
const branchOf = async (id: string) => (await one<{ branch: string | null }>('select branch from public.toy_items where id=$1', [id])).branch;

describe('Motor de túneles: capa de datos', () => {
  let session = '';

  it('registra los permisos del túnel y protege las tablas con RLS', async () => {
    expect((await q<{ key: string }>("select key from public.staff_permission_catalog where area='Túneles' order by sort_order")).map(r => r.key))
      .toEqual(['tunnels.use', 'tunnels.rules.manage', 'tunnels.cashea']);
    const rls = await q<{ relname: string; relrowsecurity: boolean }>("select relname,relrowsecurity from pg_class where relname in ('tunnel_sessions','tunnel_decisions','tunnel_rules','tunnel_ai_runs','tunnel_settings') order by relname");
    expect(rls.every(r => r.relrowsecurity)).toBe(true);
    const anonGrants = await q("select 1 from information_schema.role_table_grants where grantee='anon' and table_name like 'tunnel_%'");
    expect(anonGrants).toEqual([]);
  });

  it('abre una sola sesión por persona y túnel, y la retoma', async () => {
    const first = await one<{ r: { session: { id: string; status: string } } }>("select public.tunnel_open_session('prueba','Santiago',3) r");
    session = first.r.session.id;
    expect(first.r.session.status).toBe('OPEN');
    const again = await one<{ r: { session: { id: string }; decisions: unknown[] } }>("select public.tunnel_open_session('prueba',null,5) r");
    expect(again.r.session.id).toBe(session);
    expect(again.r.decisions).toEqual([]);
  });

  it('exige permiso del túnel', async () => {
    await setPerms('tunnels.use');
    expect(await errorOf("select public.tunnel_open_session('prueba')")).toContain('No tienes permiso para este túnel');
    await setPerms('*');
  });

  it('aplica la acción y guarda la decisión en la misma transacción', async () => {
    const d = await one<{ r: { id: string; answer: string; revert: { previous: null } } }>(
      "select public.tunnel_decide($1,'caso-a','{}'::jsonb,'YES',$2::jsonb) r", [session, assign('a', 'NORTE')]);
    expect(d.r.answer).toBe('YES');
    expect(await branchOf('a')).toBe('NORTE');
    expect(await errorOf("select public.tunnel_decide($1,'caso-a','{}'::jsonb,'YES',$2::jsonb)", [session, assign('a', 'CABUDARE')]))
      .toContain('Deshazla para cambiarla');
  });

  it('si la acción falla no queda nada a medias', async () => {
    expect(await errorOf("select public.tunnel_decide($1,'caso-b','{}'::jsonb,'YES',$2::jsonb)", [session, assign('b', 'FALLA')])).toContain('La sucursal no existe');
    expect(await one("select count(*)::int n from public.tunnel_decisions where case_id='caso-b'")).toEqual({ n: 0 });
    expect(await errorOf("select public.tunnel_decide($1,'caso-x','{}'::jsonb,'YES',$2::jsonb)", [session, JSON.stringify({ type: 'otro.borrar', payload: {} })]))
      .toContain('Acción no permitida');
  });

  it('deshace revirtiendo el efecto y deja cambiar la respuesta', async () => {
    const live = await one<{ id: string }>("select id from public.tunnel_decisions where case_id='caso-a' and undone_at is null");
    await q('select public.tunnel_undo($1)', [live.id]);
    expect(await branchOf('a')).toBe(null);
    expect(await errorOf('select public.tunnel_undo($1)', [live.id])).toContain('ya se deshizo');
    await q("select public.tunnel_decide($1,'caso-a','{}'::jsonb,'OPTION',$2::jsonb)", [session, assign('a', 'LA_MORAN')]);
    expect(await branchOf('a')).toBe('LA_MORAN');
  });

  it('un revert imposible falla con un mensaje claro y sin cambios', async () => {
    const live = await one<{ id: string }>("select id from public.tunnel_decisions where case_id='caso-a' and undone_at is null");
    await db.exec("update public.toy_items set branch='CABUDARE',version=version+1 where id='a'");
    expect(await errorOf('select public.tunnel_undo($1)', [live.id])).toContain('Otro proceso cambió este elemento');
    expect(await one('select undone_at from public.tunnel_decisions where id=$1', [live.id])).toEqual({ undone_at: null });
    expect(await branchOf('a')).toBe('CABUDARE');
  });

  it('aplica y deshace un lote completo en orden inverso', async () => {
    const batch = JSON.stringify({ type: 'tunnel.batch', label: 'Aprobar', payload: { items: [
      { case_id: 'caso-b', action: JSON.parse(assign('b', 'NORTE')) },
      { case_id: 'caso-c', action: JSON.parse(assign('c', 'NORTE')) }] } });
    const d = await one<{ r: { id: string } }>("select public.tunnel_decide($1,'batch:ref','{}'::jsonb,'YES',$2::jsonb) r", [session, batch]);
    expect([await branchOf('b'), await branchOf('c')]).toEqual(['NORTE', 'NORTE']);
    await q('select public.tunnel_undo($1)', [d.r.id]);
    expect([await branchOf('b'), await branchOf('c')]).toEqual([null, null]);
    const bad = JSON.stringify({ type: 'tunnel.batch', payload: { items: [
      { case_id: 'caso-b', action: JSON.parse(assign('b', 'NORTE')) }, { case_id: 'caso-c', action: JSON.parse(assign('c', 'FALLA')) }] } });
    expect(await errorOf("select public.tunnel_decide($1,'batch:ref2','{}'::jsonb,'YES',$2::jsonb)", [session, bad])).toContain('La sucursal no existe');
    expect(await branchOf('b')).toBe(null);
  });

  it('convierte el "no" explicado en la respuesta final y guarda la corrida de la IA', async () => {
    const decision = (await one<{ id: string }>("select public.tunnel_explain($1,'caso-c','{\"headline\":\"x\"}'::jsonb,'Es de Norte, la factura dice NT') id", [session])).id;
    const proposal = { summary: 'Es de Norte', proposal: JSON.parse(assign('c', 'NORTE')) };
    await q("select public.tunnel_record_ai($1,'claude-sonnet-5-5',100,20,'[\"buscar\"]'::jsonb,$2::jsonb,null)", [decision, JSON.stringify(proposal)]);
    expect(await one<{ ai: { summary: string } }>('select ai_proposal ai from public.tunnel_decisions where id=$1', [decision])).toMatchObject({ ai: { summary: 'Es de Norte' } });
    const done = await one<{ r: { id: string; answer: string; user_explanation: string } }>(
      "select public.tunnel_decide($1,'caso-c','{}'::jsonb,'YES',$2::jsonb,null,$3) r", [session, assign('c', 'NORTE'), decision]);
    expect(done.r).toMatchObject({ id: decision, answer: 'YES', user_explanation: 'Es de Norte, la factura dice NT' });
    expect(await branchOf('c')).toBe('NORTE');
    expect(await one("select count(*)::int n from public.tunnel_ai_runs")).toEqual({ n: 1 });
  });

  it('crea reglas activas, cuenta su uso y las administra', async () => {
    const source = (await one<{ id: string }>("select id from public.tunnel_decisions where case_id='caso-c' and undone_at is null")).id;
    const rule = await one<{ r: { id: string; status: string } }>(
      "select public.tunnel_create_rule('prueba',$1::jsonb,$2::jsonb,'Las facturas NT son de Norte',$3) r",
      [JSON.stringify({ all: [{ fact: 'invoice', op: 'startsWith', value: 'NT' }] }), JSON.stringify({ action: { type: 'prueba.assign', payload: { branch: 'NORTE' } } }), source]);
    expect(rule.r.status).toBe('ACTIVE');
    expect(await one('select rule_created_id from public.tunnel_decisions where id=$1', [source])).toEqual({ rule_created_id: rule.r.id });
    await q("select public.tunnel_decide($1,'caso-b',$2::jsonb,'YES',$3::jsonb)", [session, JSON.stringify({ ruleIds: [rule.r.id] }), assign('b', 'NORTE')]);
    expect(await one('select times_used from public.tunnel_rules where id=$1', [rule.r.id])).toEqual({ times_used: 1 });
    expect(await errorOf("select public.tunnel_create_rule('prueba','{\"all\":[{\"fact\":\"x\",\"op\":\"eq\",\"value\":1}]}'::jsonb,'{\"action\":{\"type\":\"otro.borrar\"}}'::jsonb,'Regla mala')"))
      .toContain('acción que este túnel no tiene');
    await q("select public.tunnel_update_rule($1,null,null,null,'DISABLED')", [rule.r.id]);
    expect(await one('select status from public.tunnel_rules where id=$1', [rule.r.id])).toEqual({ status: 'DISABLED' });
    await setPerms('tunnels.use,tunnels.prueba');
    expect(await errorOf('select public.tunnel_delete_rule($1)', [rule.r.id])).toContain('administrar reglas');
    const pending = await one<{ r: { status: string } }>(
      "select public.tunnel_create_rule('prueba','{\"all\":[{\"fact\":\"x\",\"op\":\"eq\",\"value\":1}]}'::jsonb,'{\"action\":{\"type\":\"prueba.assign\"}}'::jsonb,'Sin permiso de reglas') r");
    expect(pending.r.status).toBe('PENDING_APPROVAL');
    await setPerms('*');
    await q('select public.tunnel_delete_rule($1)', [rule.r.id]);
    expect(await one('select rule_created_id from public.tunnel_decisions where id=$1', [source])).toEqual({ rule_created_id: null });
  });

  it('el modo "requiere aprobación del dueño" queda preparado y apagado', async () => {
    await db.exec("insert into public.tunnel_settings(tunnel_key,rules_require_approval) values('prueba',true)");
    await asUser(OTHER);
    expect(await one("select lubricenter_private.tunnel_rule_status_for_new('prueba') s")).toEqual({ s: 'PENDING_APPROVAL' });
    await asUser(OWNER);
    expect(await one("select lubricenter_private.tunnel_rule_status_for_new('prueba') s")).toEqual({ s: 'ACTIVE' });
    await db.exec("delete from public.tunnel_settings");
  });

  it('otra persona no puede tocar la sesión', async () => {
    await asUser(OTHER);
    expect(await errorOf("select public.tunnel_decide($1,'caso-z','{}'::jsonb,'SKIP')", [session])).toContain('otra persona');
    await asUser(OWNER);
  });

  it('no cierra con el cuadre roto sin explicación', async () => {
    expect(await errorOf("select public.tunnel_close_session($1,'CLOSED','{\"ok\":false}'::jsonb)", [session])).toContain('Explica la diferencia');
    const closed = await one<{ r: { status: string } }>("select public.tunnel_close_session($1,'CLOSED','{\"ok\":false}'::jsonb,'Falta el reporte del 28') r", [session]);
    expect(closed.r.status).toBe('CLOSED');
    expect(await errorOf("select public.tunnel_decide($1,'caso-z','{}'::jsonb,'SKIP')", [session])).toContain('ya está cerrada');
    const overview = await one<{ r: { open: unknown[]; last_closed: { tunnel_key: string }[] } }>('select public.tunnel_overview() r');
    expect(overview.r.open).toEqual([]);
    expect(overview.r.last_closed[0].tunnel_key).toBe('prueba');
  });
});
