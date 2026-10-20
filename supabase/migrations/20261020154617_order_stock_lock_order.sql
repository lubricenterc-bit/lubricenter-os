create or replace function lubricenter_private.return_order_stock(p_order_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare m record; prior text:=coalesce(current_setting('lubricenter.inventory_lifecycle',true),'');
begin
 perform public.require_auth();
 -- Use the same lock order as a new sale: business counter, then stock.
 -- Corrections restore stock before creating their replacement order.
 perform 1 from lubricenter_private.order_number_counter where singleton for update;
 perform set_config('lubricenter.inventory_lifecycle','RETURN',true);
 for m in select im.* from public.inventory_movements im join public.order_items i on i.id=im.order_item_id
  where i.order_id=p_order_id and im.movement_type='SALE' order by im.inventory_item_id,im.location_id,im.id loop
  perform 1 from public.inventory_items where id=m.inventory_item_id for update;
  insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,order_item_id,note,reversal_of)
  values(m.inventory_item_id,m.location_id,-m.quantity_delta,'RETURN',m.order_item_id,p_reason,m.id)
  on conflict(reversal_of) where reversal_of is not null do nothing;
 end loop;
 perform set_config('lubricenter.inventory_lifecycle',prior,true);
end $$;