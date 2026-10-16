// Isolated authenticated browser flows. All API data comes from the disposable
// real-SQL integration fixture. Network access to production is blocked.
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../.tmp/browser-runtime/package.json',import.meta.url));
const {chromium}=require('playwright');
const directory=process.env.E2E_FIXTURE_DIR||'.tmp/ui-fixtures';
const fixtures=await Promise.all(['before','partial','full'].map(async stage=>JSON.parse(await readFile(`${directory}/${stage}.json`,'utf8'))));
const base='http://127.0.0.1:3000';
await mkdir('.tmp/ui-evidence',{recursive:true});
const browser=await chromium.launch({headless:true});
async function session(admin=true){
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 const id=admin?fixtures[0].owner:fixtures[0].operator;
 const email=admin?'lubricenterc@gmail.com':'operator@example.test';
 const exp=Math.floor(Date.now()/1000)+3600;
 const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:id,role:'authenticated',email,exp,aud:'authenticated'})).toString('base64url'),'fixture-only'].join('.');
 const user={id,email,aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
 await context.addInitScript(({token,user,exp})=>localStorage.setItem('sb-example-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',token_type:'bearer',expires_in:3600,expires_at:exp,user})),{token,user,exp});
 const state={stage:0,loss:true,requests:[],supplierWrites:[],invoiceWrites:[],detailError:false};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!url.hostname.endsWith('supabase.co'))return route.continue();
  assert.equal(url.hostname,'example.supabase.co','Production API access is forbidden in UI tests');
  const headers={'content-type':'application/json','access-control-allow-origin':base,'access-control-allow-headers':'*','content-range':'0-0/0'};
  const respond=(value,status=200)=>route.fulfill({status,headers,body:JSON.stringify(value)});
  if(request.method()==='OPTIONS')return respond(null);
  if(url.pathname.startsWith('/auth/v1/'))return respond(user);
  const data=fixtures[state.stage];
  if(url.pathname.includes('/rest/v1/rpc/')){
   const name=url.pathname.split('/').at(-1),args=request.postDataJSON()||{};
   if(name==='can_administer_orders')return respond(admin);
   if(name==='finance_role')return respond(admin?'OWNER':'OPERATOR');
   if(name==='purchasing_dashboard')return respond(data.dashboard);
   if(name==='supplier_invoice_detail')return state.detailError?respond({code:'P0001',message:'Factura no disponible (prueba aislada)'},400):respond(data.detail);
   if(name==='purchase_receipt_history')return respond(data.history);
   if(name==='get_pricing_sync_status')return respond(data.pricing);
   if(name==='get_exchange_rate_control_status')return respond(data.control);
   if(name==='get_catalog_snapshot')return respond(data.catalog);
   if(name==='get_bcv_official_status')return respond({mode:'OBSERVER',state:{last_success_at:null,last_error:null},current:null,next:null});
   if(name==='upsert_supplier'){state.supplierWrites.push(args);return respond(data.supplierId);}
   if(name==='create_supplier_invoice'){state.invoiceWrites.push(args);return respond(data.invoiceId);}
   if(name==='inventory_receive_purchase'){
    assert(admin);assert.equal(args.p_invoice_id,data.invoiceId);assert.equal(args.p_items.length,1);assert.equal(args.p_items[0].quantity,6);
    state.requests.push(args);
    const first=state.requests[0];
    if(args.p_location_id===data.cab){
     assert.equal(args.p_request_id,first.p_request_id);assert.deepEqual(args,first);state.stage=1;
     if(state.loss)return route.abort('failed');
     return respond(fixtures[1].history[0].id);
    }
    assert.equal(args.p_location_id,data.cuji);assert.notEqual(args.p_request_id,first.p_request_id);state.stage=2;
    return respond(fixtures[2].history.find(r=>r.location_name==='El Cují').id);
   }
   return respond([]);
  }
  const table=url.pathname.split('/').at(-1);
  let rows=({products:data.products,inventory_items:data.inventory,locations:data.locations,app_settings:data.settings})[table]||[];
  if(table==='app_settings'&&url.searchParams.get('key')?.startsWith('eq.'))rows=rows.filter(r=>r.key===url.searchParams.get('key').slice(3));
  if(request.headers().accept?.includes('vnd.pgrst.object'))return respond(rows[0]||null);
  return respond(rows);
 });
 const page=await context.newPage();page.setDefaultTimeout(20000);
 return {context,page,state};
}
try{
 const {context,page,state}=await session();
 await page.goto(`${base}/settings`);
 await page.getByRole('heading',{name:'Control de tasas · Notion'}).waitFor();
 await page.getByText('Actualiza las tasas en Notion; su sincronización permanece activa.').waitFor();
 assert(await page.getByLabel('Nueva tasa operativa (Bs por USD)').isDisabled());
 await page.goto(`${base}/catalog/manage`);
 await page.locator('main').getByText('Aceite de prueba',{exact:true}).first().waitFor();
 await page.screenshot({path:'.tmp/ui-evidence/catalog.png',fullPage:true});
 await page.goto(`${base}/suppliers`);
 await page.waitForURL('**/expenses?tab=SUPPLIERS');
 await page.getByRole('heading',{name:'Base maestra de proveedores'}).waitFor();
 await page.getByRole('button',{name:'+ Proveedor',exact:true}).first().click();
 let sheet=page.locator('.sheet').last();
 await sheet.getByLabel('Nombre comercial').fill('Proveedor de prueba');
 await sheet.getByRole('button',{name:'Guardar proveedor',exact:true}).click();
 await page.locator('.sheet').waitFor({state:'detached'});
 assert.equal(state.supplierWrites[0].p_name,'Proveedor de prueba');
 await page.getByRole('button',{name:'+ Factura de proveedor',exact:true}).click();
 sheet=page.locator('.sheet').last();
 await sheet.getByLabel('Número de factura').fill('SIM-01');
 await sheet.locator(`select:has(option[value="${fixtures[0].skuId}"])`).selectOption(fixtures[0].skuId);
 await sheet.locator('input[type="number"]').nth(0).fill('12');
 await sheet.locator('input[type="number"]').nth(1).fill('3516');
 await sheet.getByRole('button',{name:/(Guardar|Registrar) factura/}).click();
 await page.waitForURL(`**/purchases/${fixtures[0].invoiceId}`);
 assert.equal(state.invoiceWrites[0].p_currency,'VES');
 assert.equal(state.invoiceWrites[0].p_items[0].quantity,12);
 await page.getByRole('button',{name:'+ Recibir mercancía',exact:true}).click();
 let dialog=page.getByRole('dialog',{name:'Recibir mercancía'});
 assert.equal(await dialog.getByLabel('Cantidad recibida: Aceite de prueba').inputValue(),'0');
 await dialog.getByLabel('Cantidad recibida: Aceite de prueba').fill('6');
 await dialog.getByRole('button',{name:'Confirmar entrada al inventario'}).click();
 await dialog.getByRole('alert').waitFor();
 await page.reload();
 await page.getByRole('button',{name:'Recuperar recepción pendiente'}).click();
 dialog=page.getByRole('dialog',{name:'Recibir mercancía'});
 assert(await dialog.getByLabel('Cantidad recibida: Aceite de prueba').isDisabled());
 state.loss=false;
 await dialog.getByRole('button',{name:'Reintentar y recuperar comprobante'}).click();
 await dialog.waitFor({state:'detached'});
 await page.getByText('Inventario · recibido 6 de 12').waitFor();
 await page.getByRole('button',{name:'+ Recibir mercancía',exact:true}).click();
 dialog=page.getByRole('dialog',{name:'Recibir mercancía'});
 await dialog.getByLabel('Sede de destino').selectOption(fixtures[0].cuji);
 await dialog.getByLabel('Cantidad recibida: Aceite de prueba').fill('6');
 await dialog.getByRole('button',{name:'Confirmar entrada al inventario'}).click();
 await dialog.waitFor({state:'detached'});
 await page.getByText('Inventario · recibido 12 de 12').waitFor();
 assert.equal(new Set(state.requests.map(r=>r.p_request_id)).size,2);
 await page.getByText(/Promedio global:/).first().waitFor();
 assert.equal(await page.getByRole('button',{name:'+ Recibir mercancía',exact:true}).count(),0);
 await page.screenshot({path:'.tmp/ui-evidence/receipts-two-sites.png',fullPage:true});
 state.detailError=true;await page.reload();
 await page.getByText('Factura no disponible (prueba aislada)',{exact:true}).waitFor();
 assert.equal(await page.getByText('Inventario · recibido 12 de 12').count(),0);
 await context.close();
 const operator=await session(false);
 await operator.page.goto(`${base}/expenses`);
 await operator.page.getByRole('button',{name:'+ Factura de proveedor',exact:true}).waitFor();
 assert(await operator.page.getByRole('button',{name:'+ Factura de proveedor',exact:true}).isDisabled());
 await operator.page.goto(`${base}/purchases/${fixtures[0].invoiceId}`);
 await operator.page.getByText('Recepción de mercancía',{exact:true}).waitFor();
 assert.equal(await operator.page.getByRole('button',{name:'+ Recibir mercancía',exact:true}).count(),0);
 await operator.context.close();
 console.log('UI acceptance passed: authenticated fixture, native catalog + Notion rates, supplier/invoice forms, durable receipt retry, two sites, history, error and operator restrictions.');
}finally{await browser.close();}
