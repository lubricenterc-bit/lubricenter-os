import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';

type Handler=(event:any)=>void;

function loadWorker(options?:{cached?:Response|null;fetchImpl?:(r:Request)=>Promise<Response>;hostname?:string;store?:Map<string,Response>}) {
  const handlers:Record<string,Handler>={};
  const selfMock:any={
    location:{origin:'https://lubricenter.test',hostname:options?.hostname??'lubricenter.test'},
    addEventListener:(name:string,handler:Handler)=>{handlers[name]=handler;},
    skipWaiting:vi.fn(),
    clients:{claim:vi.fn(),matchAll:vi.fn(),openWindow:vi.fn()},
    registration:{showNotification:vi.fn()}
  };
  const store=options?.store??new Map<string,Response>();
  const cacheObj={
    addAll:vi.fn(),
    match:vi.fn(async(r:Request)=>store.get(r.url)?.clone()),
    put:vi.fn(async(r:Request,res:Response)=>{store.set(r.url,res);}),
    keys:vi.fn(async()=>[...store.keys()].map(u=>new Request(u))),
    delete:vi.fn(async(r:Request)=>store.delete(r.url)),
  };
  const cachesMock:any={
    open:vi.fn(async()=>cacheObj),
    keys:vi.fn(async()=>[]),
    delete:vi.fn(async()=>true),
    match:vi.fn(async()=>options?.cached??undefined)
  };
  const failingFetch=vi.fn(options?.fetchImpl??(async()=>{throw new Error('offline');}));
  const source=readFileSync('public/sw.js','utf8');
  new Function('self','caches','fetch','Response','URL',source)(selfMock,cachesMock,failingFetch,Response,URL);
  return {handlers,cachesMock,failingFetch,store};
}

describe('service worker fetch fallback',()=>{
  it('never resolves respondWith to null/undefined when network and cache both fail',async()=>{
    const {handlers}=loadWorker();
    let promise:Promise<Response>|undefined;
    handlers.fetch({
      request:new Request('https://lubricenter.test/promociones/aceite'),
      respondWith:(p:Promise<Response>)=>{promise=p;}
    });
    expect(promise).toBeTruthy();
    const response=await promise!;
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(503);
  });

  it('returns valid JSON 503 for failed API GET instead of an invalid response',async()=>{
    const {handlers}=loadWorker();
    let promise:Promise<Response>|undefined;
    handlers.fetch({
      request:new Request('https://lubricenter.test/api/campaigns/oil-promo'),
      respondWith:(p:Promise<Response>)=>{promise=p;}
    });
    const response=await promise!;
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toHaveProperty('error');
  });

  it('uses cache when a normal GET is offline and a cached response exists',async()=>{
    const cached=new Response('cached',{status:200});
    const {handlers}=loadWorker({cached});
    let promise:Promise<Response>|undefined;
    handlers.fetch({
      request:new Request('https://lubricenter.test/orders'),
      respondWith:(p:Promise<Response>)=>{promise=p;}
    });
    expect(await (await promise!).text()).toBe('cached');
  });

  it('does not intercept mutation requests',()=>{
    const {handlers}=loadWorker();
    const respondWith=vi.fn();
    handlers.fetch({
      request:new Request('https://lubricenter.test/api/campaigns/oil-promo',{method:'PATCH'}),
      respondWith
    });
    expect(respondWith).not.toHaveBeenCalled();
  });
});

function dispatch(handlers:Record<string,Handler>,url:string){
  let promise:Promise<Response>|undefined;
  const waits:Promise<unknown>[]=[];
  handlers.fetch({request:new Request(url),respondWith:(p:Promise<Response>)=>{promise=p;},waitUntil:(p:Promise<unknown>)=>waits.push(p)});
  return {promise,waits};
}

describe('service worker static asset strategy',()=>{
  const chunk='https://lubricenter.test/_next/static/chunks/app-abc123.js';

  it('serves hashed Next assets from cache without touching the network',async()=>{
    const store=new Map([[chunk,new Response('cached-chunk')]]);
    const {handlers,failingFetch}=loadWorker({store});
    const {promise}=dispatch(handlers,chunk);
    expect(await (await promise!).text()).toBe('cached-chunk');
    expect(failingFetch).not.toHaveBeenCalled();
  });

  it('stores a hashed asset after the first network download',async()=>{
    const {handlers,store}=loadWorker({fetchImpl:async()=>new Response('fresh',{status:200})});
    const {promise}=dispatch(handlers,chunk);
    expect(await (await promise!).text()).toBe('fresh');
    expect(store.has(chunk)).toBe(true);
  });

  it('does not cache-first dev chunks on localhost',async()=>{
    const url='https://lubricenter.test/_next/static/chunks/x.js';
    const store=new Map([[url,new Response('stale')]]);
    const {handlers,failingFetch}=loadWorker({store,hostname:'localhost',fetchImpl:async()=>new Response('live')});
    const {promise}=dispatch(handlers,'https://lubricenter.test/_next/static/chunks/x.js');
    expect(await (await promise!).text()).toBe('live');
    expect(failingFetch).toHaveBeenCalled();
  });

  it('serves brand icons from cache and refreshes them in the background',async()=>{
    const icon='https://lubricenter.test/pwa/icon-192.png';
    const store=new Map([[icon,new Response('old-icon')]]);
    const {handlers,failingFetch}=loadWorker({store,fetchImpl:async()=>new Response('new-icon')});
    const {promise,waits}=dispatch(handlers,icon);
    expect(await (await promise!).text()).toBe('old-icon');
    await Promise.all(waits);
    expect(failingFetch).toHaveBeenCalled();
    expect(await store.get(icon)!.text()).toBe('new-icon');
  });

  it('keeps pages network-first so a deploy is never hidden behind a stale shell',async()=>{
    const page='https://lubricenter.test/orders';
    const store=new Map([[page,new Response('old-page')]]);
    const {handlers}=loadWorker({store,fetchImpl:async()=>new Response('new-page')});
    const {promise}=dispatch(handlers,page);
    expect(await (await promise!).text()).toBe('new-page');
  });
});
