import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOwnerApprovalHold, isRegisteredRuleWarning, laborRuleNotice } from '../lib/payroll-registered-rule';

const migration = readFileSync('supabase/migrations/20261114170000_payroll_registered_rule.sql', 'utf8');
let db: PGlite;
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const VEHICLE = '00000000-0000-4000-8000-00000000f001';

async function work(opts: { day: string; customer?: string | null; vehicle?: string | null; source?: string; decision?: string; reversal?: boolean }) {
  const order = await one<{ id: string }>(`insert into public.orders(customer_id, vehicle_id, business_at, closed_at)
    values ($1, $2, ($3::date + time '15:00') at time zone 'America/Caracas', ($3::date + time '15:00') at time zone 'America/Caracas') returning id`,
    [opts.customer === undefined ? CUSTOMER : opts.customer, opts.vehicle === undefined ? VEHICLE : opts.vehicle, opts.day]);
  return one<{ decision: string; reason: string | null }>(`insert into public.payroll_work_items(order_id, source_type, decision, reversal_of, earned_at)
    values ($1, $2, $3, $4, now()) returning decision, reason`,
    [order.id, opts.source ?? 'WORKSHOP_COMMISSION', opts.decision ?? 'PAY', opts.reversal ? '00000000-0000-4000-8000-000000000999' : null]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
   create role anon; create role authenticated;
   create schema lubricenter_private;
   create table public.app_settings(key text primary key, value jsonb not null, updated_at timestamptz not null default now());
   create table public.orders(id uuid primary key default gen_random_uuid(), customer_id uuid, vehicle_id uuid, business_at timestamptz, closed_at timestamptz);
   create table public.payroll_work_items(id uuid primary key default gen_random_uuid(), order_id uuid, source_type text,
     decision text not null default 'PAY' check (decision in ('PAY','HOLD','EXCLUDE')), reason text, reversal_of uuid, earned_at timestamptz);
  `);
  await db.exec(migration);
  await db.exec(migration); // Reaplicable.
}, 120000);
afterAll(async () => { await db?.close(); });

describe('regla de nómina etapa 1: orden con cliente y vehículo', () => {
  it('antes del 23 nov no cambia nada', async () => {
    expect(await work({ day: '2026-11-21', customer: null })).toEqual({ decision: 'PAY', reason: null });
  });

  it('del 23 al 29 nov (marcha blanca) se paga y lleva el aviso', async () => {
    const w = await work({ day: '2026-11-28', vehicle: null });
    expect(w.decision).toBe('PAY');
    expect(w.reason).toMatch(/^Marcha blanca: desde el 30\/11/);
    expect(isRegisteredRuleWarning(w)).toBe(true);
  });

  it('desde el 30 nov, sin cliente o sin vehículo queda «Por aprobar del dueño» y no se liquida', async () => {
    for (const w of [await work({ day: '2026-11-30', customer: null }), await work({ day: '2026-12-02', vehicle: null }),
      await work({ day: '2026-12-02', customer: null, vehicle: null, source: 'ASSISTANT_BONUS' }),
      await work({ day: '2026-12-02', customer: null, source: 'ELECTROAUTO_COMMISSION' })]) {
      expect(w.decision).toBe('HOLD');
      expect(isOwnerApprovalHold(w)).toBe(true);
    }
  });

  it('con cliente y vehículo se paga normal', async () => {
    expect(await work({ day: '2026-12-02' })).toEqual({ decision: 'PAY', reason: null });
  });

  it('la fecha es la del negocio en Caracas (9 p. m. del 29 nov sigue siendo marcha blanca)', async () => {
    const order = await one<{ id: string }>(`insert into public.orders(customer_id, business_at) values (null, '2026-11-30T01:00:00Z') returning id`);
    const w = await one<{ decision: string }>(`insert into public.payroll_work_items(order_id, source_type) values ($1, 'WORKSHOP_COMMISSION') returning decision`, [order.id]);
    expect(w.decision).toBe('PAY');
  });

  it('no toca reversiones, exclusiones ni otros tipos de pago', async () => {
    expect((await work({ day: '2026-12-02', customer: null, reversal: true })).decision).toBe('PAY');
    expect((await work({ day: '2026-12-02', customer: null, decision: 'EXCLUDE' })).decision).toBe('EXCLUDE');
    expect((await work({ day: '2026-12-02', customer: null, source: 'OTHER' })).decision).toBe('PAY');
  });

  it('el dueño puede mover la fecha de inicio sin migración', async () => {
    await db.exec(`update public.app_settings set value = '"2026-12-07"' where key = 'payroll_registered_rule_from'`);
    expect((await work({ day: '2026-12-02', customer: null })).decision).toBe('PAY');
    await db.exec(`update public.app_settings set value = '"2026-11-30"' where key = 'payroll_registered_rule_from'`);
  });

  it('el aviso en la orden aparece solo si falta cliente o vehículo', () => {
    expect(laborRuleNotice(true, true)).toBeNull();
    expect(laborRuleNotice(true, false)).toMatch(/por aprobar del dueño/);
  });
});
