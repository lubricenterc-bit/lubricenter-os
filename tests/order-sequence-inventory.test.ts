import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,it,expect,describe} from 'vitest';
const sql=readFileSync(new URL('../supabase/migrations/20261020151302_order_sequence_inventory_integrity.sql',import.meta.url),'utf8');
function def(name:string){const a=sql.indexOf('create or replace function lubricenter_private.'+name+'('),b=sql.indexOf('end $$;',a);if(a<0||b<0)throw Error(name);return sql.slice(a,b+7);}
describe('business order numbering uses the same transaction',()=>{
 let db:PGlite;
 beforeEach(async()=>{db=new PGlite();await db.exec(`create schema lubricenter_private;create function public.require_auth() returns void language plpgsql as $$begin return;end$$;
 create table public.orders(id uuid primary key default gen_random_uuid(),order_seq bigint generated always as identity unique,status text default 'OPEN');
 insert into orders(order_seq) overriding system value values(292);`);
 await db.exec('begin;'+sql.slice(0,sql.indexOf('create table lubricenter_private.order_number_explanations')) .replace('grant execute on function lubricenter_private.allocate_order_number() to authenticated;','').replace('revoke all on function lubricenter_private.allocate_order_number() from public,anon;','')+'commit;');},30000);
 afterEach(async()=>{await db.close();});
 it('preserves existing numbers and starts after the highest issued number',async()=>{const r=await db.query<{order_seq:number}>(`insert into orders default values returning order_seq`);expect(Number(r.rows[0].order_seq)).toBe(293);expect((await db.query('select * from orders where order_seq=292')).rows.length).toBe(1);});
 it('rolls back allocation along with the unsuccessful transaction',async()=>{await db.exec('begin;insert into orders default values;rollback;');const r=await db.query<{order_seq:number}>('insert into orders default values returning order_seq');expect(Number(r.rows[0].order_seq)).toBe(293);});
 it('retains the number of a cancelled order and allocates the next one',async()=>{await db.exec("insert into orders(status) values('CANCELLED');");const r=await db.query<{order_seq:number}>('insert into orders default values returning order_seq');expect(Number(r.rows[0].order_seq)).toBe(294);});
});
describe('immutable order inventory ledger',()=>{
 let db:PGlite;
 beforeEach(async()=>{db=new PGlite();await db.exec(`create schema lubricenter_private;
 create table public.order_items(id uuid primary key,inventory_item_id uuid,quantity numeric);
 create table public.inventory_movements(id uuid primary key default gen_random_uuid(),order_item_id uuid,inventory_item_id uuid,location_id uuid,quantity_delta numeric,movement_type text,reversal_of uuid unique);
 insert into order_items values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',2);`);
 await db.exec(def('guard_inventory_ledger')+`create trigger guard before insert or update or delete on inventory_movements for each row execute function lubricenter_private.guard_inventory_ledger();`);},30000);
 afterEach(async()=>{await db.close();});
 const sale=`insert into inventory_movements(id,order_item_id,inventory_item_id,location_id,quantity_delta,movement_type) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004',-2,'SALE')`;
 it('rejects a manual stock sale outside the order closing process',async()=>{await expect(db.exec(sale)).rejects.toThrow('La salida se genera al cerrar');});
 it('preserves a committed stock movement against editing or erasure',async()=>{await db.exec("select set_config('lubricenter.inventory_lifecycle','SALE',false);"+sale);await expect(db.exec('update inventory_movements set quantity_delta=-3')).rejects.toThrow('El inventario conserva');await expect(db.exec('delete from inventory_movements')).rejects.toThrow('El inventario conserva');});
 it('requires an exact reversal and prevents returning the same sale twice',async()=>{await db.exec("select set_config('lubricenter.inventory_lifecycle','SALE',false);"+sale+";select set_config('lubricenter.inventory_lifecycle','RETURN',false);");const ret=`insert into inventory_movements(order_item_id,inventory_item_id,location_id,quantity_delta,movement_type,reversal_of) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004',2,'RETURN','00000000-0000-4000-8000-000000000003')`;await expect(db.exec(ret.replace(",2,'RETURN'",",3,'RETURN'"))).rejects.toThrow('devolución debe revertir');await db.exec(ret);await expect(db.exec(ret)).rejects.toThrow();expect(Number((await db.query<{qty:string}>('select sum(quantity_delta) qty from inventory_movements')).rows[0].qty)).toBe(0);});
});
