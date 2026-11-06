-- La vista current_exchange_rates solo lee tasas con origen 'Notion · Tasas'. Tasa de arranque (Notion, 29 oct): BCV 888,8909; en Norte la operativa = BCV.
insert into public.exchange_rates(rate_type,value,effective_at,source) values
 ('BCV',888.8909,now(),'Notion · Tasas'),
 ('OPERATIVE',888.8909,now(),'Notion · Tasas');