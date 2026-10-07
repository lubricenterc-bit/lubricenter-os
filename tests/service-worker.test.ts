import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';

type Handler=(event:any)=>void;

function loadWorker(options?:{cached?:Response|null}) {
  const handlers:Record<string,Handler>={};
  const selfMock:any={
    location:{origin:'https://lubricenter.test'},
    addEventListener:(name:string,handler:Handler)=>{handlers[name]=handler;},
    skipWaiting:vi.fn(),
    clients:{claim:vi.fn(),matchAll:vi.fn(),openWindow:vi.fn()},
    registration:{showNotification:vi.fn()}
  };
  const cachesMock:any={
    open:vi.fn(async()=>({addAll:vi.fn()})),
    keys:vi.fn(async()=>[]),
    delete:vi.fn(async()=>true),
    match:vi.fn(async()=>options?.cached??undefined)
  };
  const failingFetch=vi.fn(async()=>{throw new Error('offline');});
  const source=readFileSync('public/sw.js','utf8');
  new Function('self','caches','fetch','Response','URL',source)(selfMock,cachesMock,failingFetch,Response,URL);
  return {handlers,cachesMock,failingFetch};
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
