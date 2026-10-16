// Authenticated Chromium acceptance against disposable SQL fixtures only.
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../.tmp/browser-runtime/package.json',import.meta.url));
const {chromium}=require('playwright');
const fixture=JSON.parse(await readFile('.tmp/finance-fixtures/finance.json','utf8'));
const base='http://127.0.0.1:3000';
await mkdir('.tmp/ui-evidence',{recursive:true});
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1050},serviceWorkers:'block'});
 const exp=Math.floor(Date.now()/1000)+3600;
 const user={id:fixture.owner,email:'lubricenterc@gmail.com',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
 const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,role:'authenticated',email:user.email,exp,aud:'authenticated'})).toString('base64url'),'fixture-only'].join('.');
 await context.addInitScript(({token,user,exp})=>localStorage.setItem('sb-example-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',token_type:'bearer',expires_in:3600,expires_at:exp,user})),{token,user,exp});
 const requests=[];let fail=false;
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(!url.hostname.endsWith('supabase.co'))return route.continue();
  assert.equal(url.hostname,'example.supabase.co','Never contact production during browser acceptance');
  const headers={'content-type':'application/json','access-control-allow-origin':base,'access-control-allow-headers':'*','content-range':'0-0/0'};
  const respond=(data,status=200)=>route.fulfill({status,headers,body:JSON.stringify(data)});
  if(req.method()==='OPTIONS')return respond(null);
  if(url.pathname.startsWith('/auth/v1/'))return respond(user);
  const name=url.pathname.split('/').at(-1);
  if(name==='finance_role')return respond('OWNER');
  if(name==='finance_management_report'){
   const args=req.postDataJSON();requests.push(args);
   if(fail)return respond({code:'P0001',message:'Error de prueba del reporte'},500);
   const report=structuredClone(fixture.report);report.period.from=args.p_from;report.period.to=args.p_to;report.receivables.as_of=args.p_to;
   if(args.p_from>'2026-09-10'||args.p_to<'2026-09-10'){
    report.orders=[];report.totals={orders:0,gross_ves:0,sales_equivalent:0};
    for(const c of Object.values(report.channels)){c.orders=0;c.equivalent=0;c.ves=0;c.usd=0;}
   }
   return respond(report);
  }
  if(name==='finance_currency_summary')return respond(fixture.currency);
  if(name==='finance_sales_bcv')return respond(fixture.billing);
  if(name==='get_pricing_sync_status')return respond([{catalog_synced_at:new Date().toISOString(),catalog_products:76,bcv_rate:800,bcv_effective_at:new Date().toISOString(),operative_rate:1000,operative_effective_at:new Date().toISOString()}]);
  if(name==='get_exchange_rate_control_status')return respond({catalog_authority:'LUBRICENTER_OS',exchange_rate_authority:'NOTION',rates_fresh:true,catalog_version:'fixture'});
  if(name==='locations')return respond([{id:'fixture',name:'Lubricenter Cabudare'}]);
  if(name==='app_settings')return respond([]);
  return respond([]);
 });
 const page=await context.newPage();page.setDefaultTimeout(20000);
 const exceptions=[];page.on('pageerror',e=>exceptions.push(e.message));
 await page.goto(base+'/finance?from=2026-09-10&to=2026-09-10');
 await page.getByTestId('finance-total').filter({hasText:'330'}).waitFor();
 assert.equal(await page.locator('.finance-orders-card tbody tr').count(),4);
 assert.equal(await page.getByLabel('Día del reporte',{exact:true}).inputValue(),'2026-09-10');
 assert.equal(await page.locator('.finance-channel-card').count(),4);
 await page.screenshot({path:'.tmp/ui-evidence/finance-desktop.png',fullPage:true});
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar Excel / CSV'}).click();
 const download=await downloadEvent;await download.saveAs('.tmp/ui-evidence/finance-report.csv');
 const csv=await readFile('.tmp/ui-evidence/finance-report.csv','utf8');assert(csv.includes('330,0000'));assert(csv.includes('Cashea'));
 await page.emulateMedia({media:'print'});
 assert.equal(await page.locator('.finance-controls').evaluate(e=>getComputedStyle(e).display),'none');
 assert(await page.evaluate(()=>document.body.getBoundingClientRect().width>600),'Financial reports must not inherit the 58mm thermal receipt width');
 await page.pdf({path:'.tmp/ui-evidence/finance-report.pdf',format:'A4',printBackground:true});
 await page.emulateMedia({media:'screen'});
 fail=true;await page.getByLabel('Día del reporte',{exact:true}).fill('2026-09-11');
 await page.getByRole('alert').filter({hasText:'Error de prueba del reporte'}).waitFor();
 assert.equal(await page.locator('.finance-orders-card').count(),0,'Do not show stale orders after a failed date change');
 fail=false;await page.getByRole('button',{name:'Reintentar',exact:true}).click();
 await page.getByText('No hay órdenes facturadas en la fecha seleccionada.').waitFor();
 assert(requests.some(r=>r.p_from==='2026-09-11'&&r.p_to==='2026-09-11'));
 assert(new URL(page.url()).searchParams.get('from')==='2026-09-11');
 await page.reload();await page.getByText('No hay órdenes facturadas en la fecha seleccionada.').waitFor();
 assert.equal(await page.getByLabel('Día del reporte',{exact:true}).inputValue(),'2026-09-11');
 await page.getByLabel('Día anterior',{exact:true}).click();await page.getByTestId('finance-total').filter({hasText:'330'}).waitFor();
 await page.getByRole('button',{name:'Rango de fechas',exact:true}).click();
 await page.getByLabel('Desde',{exact:true}).fill('2026-09-09');
 await page.getByRole('heading',{name:'Órdenes del período',exact:true}).waitFor();
 assert(requests.some(r=>r.p_from==='2026-09-09'&&r.p_to==='2026-09-10'));
 await page.getByRole('button',{name:'Un día',exact:true}).click();
 await page.getByLabel('Día del reporte',{exact:true}).fill('2026-09-10');await page.getByTestId('finance-total').filter({hasText:'330'}).waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'.tmp/ui-evidence/finance-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Report must fit a mobile viewport');
 assert.deepEqual(exceptions,[]);
 await context.close();
 process.stdout.write('Finance report UI passed: daily and historical dates, exact order list, total and four channels, CSV/PDF, mobile width, stale-error recovery and shared-date reload.\n');
}finally{await browser.close();}
