import {describe,it,expect,beforeEach,vi} from 'vitest';
import {normalizePhone,selectContacts,campaignMessage,type Service} from '../lib/campaign/oil-promo';
import {loginReturnPath} from '../lib/login-return';

const customer={id:'customer-1',name:'Cliente prueba',phone:'04141234567'};
const vehicle={id:'vehicle-1',customer_id:customer.id,make:'Chevrolet',model:'Aveo',year:null,plate:'TEST'};
const oil:Service={vehicle_id:vehicle.id,performed_at:'2026-01-01T16:00:00Z',service_type:'OIL_CHANGE',description:'Cambio de aceite',service_notes:null,oil_brand:'Marca',oil_viscosity:'20W50',next_service_date:'2026-04-01'};

describe('campaña de aceite',()=>{
  it('normaliza el contacto nacional sin aceptar números vacíos o ficticios',()=>{expect(normalizePhone('0414-123-4567')).toBe('584141234567');expect(normalizePhone('00000000000')).toBeNull();expect(normalizePhone(null)).toBeNull();});
  it('elige clientes vencidos e inactivos e incluye un enlace con emojis y negritas intactos',()=>{const c=selectContacts([customer],[vehicle],[oil],[],'2026-10-06')[0];expect(c.kind).toBe('reenganche');expect(c.first).toBe(true);expect(new URL(c.url).searchParams.get('text')).toBe(c.message);expect(c.message).toContain('👋😊');expect(c.message).toContain('*limpieza de inyectores GRATIS*');expect(c.message).not.toMatch(/70%|50%|18 de octubre/);expect(c.message).toContain('Solo por pocos días');expect(c.message).toContain('Aplican condiciones');expect(c.message).toContain('filtro');expect(c.message).toContain('Lubricenter Cabudare');});
  it('reserva aceite e inyectores recientes en lugar de reofrecerlos',()=>{expect(selectContacts([customer],[vehicle],[{...oil,performed_at:'2026-09-10T16:00:00Z'}],[],'2026-10-06')).toHaveLength(0);expect(selectContacts([customer],[vehicle],[oil,{...oil,oil_brand:null,oil_viscosity:null,service_type:'WORKSHOP',description:'Limpieza de inyectores',performed_at:'2026-10-01T16:00:00Z'}],[],'2026-10-06')).toHaveLength(0);});
  it('una visita posterior al taller evita etiquetar al cliente como dormido',()=>{const c=selectContacts([customer],[vehicle],[oil],[{vehicle_id:vehicle.id,business_at:'2026-09-30T16:00:00Z',closed_at:null,opened_at:'2026-09-30T16:00:00Z'}],'2026-10-06')[0];expect(c.kind).toBe('mantenimiento');expect(c.reason).not.toContain('sin visita');});
  it('no inventa inactividad cuando no hay historial y no contacta dos veces el mismo teléfono',()=>{expect(selectContacts([customer],[vehicle],[],[],'2026-10-06')).toHaveLength(0);const second={...vehicle,id:'vehicle-2'};expect(selectContacts([customer],[vehicle,second],[oil,{...oil,vehicle_id:second.id}],[],'2026-10-06')).toHaveLength(1);});
  it('no permite que nombres almacenados alteren el formato del mensaje',()=>{const text=campaignMessage({name:'Persona*\nGRATIS',vehicle:'Carro_*',kind:'reenganche'});expect(text).toContain('¡Hola, Persona GRATIS!');expect(text).toContain('*Carro*');});
  it('regresa al enlace privado después del login e impide redirecciones externas',()=>{expect(loginReturnPath('/promociones/aceite')).toBe('/promociones/aceite');expect(loginReturnPath('/campaigns')).toBe('/campaigns');for(const value of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/login',null])expect(loginReturnPath(value)).toBe('/');});
});

const authMock=vi.hoisted(()=>({getUser:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({auth:{getUser:authMock.getUser},rpc:authMock.rpc,from:authMock.from})}));
import {GET,PATCH} from '../app/api/campaigns/oil-promo/route';

function thenable(data:unknown,error:unknown=null){
  const q:any={select:()=>q,order:()=>q,range:()=>q,eq:()=>q,then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({data,error}).then(resolve)};
  return q;
}
const campaign={id:'campaign-1',slug:'aceite-inyectores-oct-2026',name:'Cambio de aceite + limpieza de inyectores',status:'ACTIVE',objective:'CASH_FLOW',starts_on:'2026-10-06',ends_on:'2026-10-10'};
const storedContact={
  id:'campaign-contact-1',campaign_id:campaign.id,customer_id:customer.id,vehicle_id:vehicle.id,
  name_snapshot:customer.name,phone_snapshot:'584141234567',vehicle_snapshot:'Chevrolet Aveo',plate_snapshot:'TEST',
  segment:'reenganche',priority:true,rank:1,reason:'279 días sin visita registrada de este vehículo',
  message_snapshot:campaignMessage({name:customer.name,vehicle:'Chevrolet Aveo',kind:'reenganche'}),status:'PENDING',
  sent_at:null,responded_at:null,scheduled_for:null,visited_at:null,converted_at:null,converted_order_id:null,outcome_note:null
};

describe('acceso privado y estado cloud de campañas',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL='https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='public-test';
    authMock.getUser.mockResolvedValue({data:{user:{id:'owner-test'}},error:null});
  });
  it('no expone datos sin sesión y desactiva la caché',async()=>{
    const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo'));
    expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');expect(authMock.from).not.toHaveBeenCalled();
  });
  it('rechaza un token no validado sin consultar clientes',async()=>{
    authMock.getUser.mockResolvedValue({data:{user:null},error:{message:'invalid'}});
    const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo',{headers:{Authorization:'Bearer invalid'}}));
    expect(response.status).toBe(401);expect(authMock.rpc).not.toHaveBeenCalled();expect(authMock.from).not.toHaveBeenCalled();
  });
  it('rechaza operadores antes de leer datos',async()=>{
    authMock.rpc.mockResolvedValue({data:'OPERATOR',error:null});
    const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo',{headers:{Authorization:'Bearer test'}}));
    expect(response.status).toBe(403);expect(authMock.from).not.toHaveBeenCalled();
  });
  it('entrega el estado cloud y conserva enlaces personalizados',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-06T16:00:00Z'));
    try{
      authMock.rpc.mockResolvedValue({data:'OWNER',error:null});
      let contactsRead=0;
      authMock.from.mockImplementation((table:string)=>{
        if(table==='crm_campaigns'){
          const q:any={select:()=>q,eq:()=>q,single:()=>Promise.resolve({data:campaign,error:null})};return q;
        }
        if(table==='crm_campaign_contacts'){
          contactsRead++;
          return thenable([storedContact]);
        }
        const tables:Record<string,unknown[]>={customers:[customer],vehicles:[vehicle],service_records:[oil],orders:[]};
        return thenable(tables[table]||[]);
      });
      const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo',{headers:{Authorization:'Bearer test'}}));
      expect(response.status).toBe(200);expect(response.headers.get('vary')).toBe('Authorization');
      const data=await response.json();expect(data.asOf).toBe('2026-10-06');expect(data.contacts).toHaveLength(1);
      expect(data.contacts[0].status).toBe('PENDING');expect(data.contacts[0].url).toContain('https://wa.me/584141234567?text=');
      expect(contactsRead).toBe(2);
    }finally{vi.useRealTimers();}
  });
  it('crea candidatos que todavía no existen en el seguimiento cloud',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-06T16:00:00Z'));
    try{
      authMock.rpc.mockResolvedValue({data:'OWNER',error:null});
      let contactsRead=0;let inserted:unknown[]=[];
      authMock.from.mockImplementation((table:string)=>{
        if(table==='crm_campaigns'){const q:any={select:()=>q,eq:()=>q,single:()=>Promise.resolve({data:campaign,error:null})};return q;}
        if(table==='crm_campaign_contacts'){
          contactsRead++;
          if(contactsRead===1)return thenable([]);
          if(contactsRead===2){const q:any={insert:(rows:unknown[])=>{inserted=rows;return Promise.resolve({error:null});}};return q;}
          return thenable([storedContact]);
        }
        const tables:Record<string,unknown[]>={customers:[customer],vehicles:[vehicle],service_records:[oil],orders:[]};
        return thenable(tables[table]||[]);
      });
      const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo',{headers:{Authorization:'Bearer test'}}));
      expect(response.status).toBe(200);expect(inserted).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });
  it('guarda un resultado comercial solo dentro de la campaña autorizada',async()=>{
    authMock.rpc.mockResolvedValue({data:'OWNER',error:null});
    let updated:Record<string,unknown>|null=null;
    authMock.from.mockImplementation((table:string)=>{
      if(table==='crm_campaigns'){const q:any={select:()=>q,eq:()=>q,single:()=>Promise.resolve({data:campaign,error:null})};return q;}
      if(table==='crm_campaign_contacts'){
        const q:any={update:(patch:Record<string,unknown>)=>{updated=patch;return q;},eq:()=>q,select:()=>q,single:()=>Promise.resolve({data:{...storedContact,status:'RESPONDED'},error:null})};return q;
      }
      return thenable([]);
    });
    const response=await PATCH(new Request('https://test.invalid/api/campaigns/oil-promo',{method:'PATCH',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({contactId:storedContact.id,status:'RESPONDED'})}));
    expect(response.status).toBe(200);expect(updated?.status).toBe('RESPONDED');expect(updated?.responded_at).toBeTruthy();
  });
  it('permite administradores con RLS y falla sin devolver una lista incompleta',async()=>{
    authMock.rpc.mockResolvedValue({data:'ADMIN',error:null});
    authMock.from.mockImplementation((table:string)=>{
      if(table==='crm_campaigns'){const q:any={select:()=>q,eq:()=>q,single:()=>Promise.resolve({data:campaign,error:null})};return q;}
      return thenable(null,{message:'denied'});
    });
    const response=await GET(new Request('https://test.invalid/api/campaigns/oil-promo',{headers:{Authorization:'Bearer test'}}));
    expect(response.status).toBe(503);expect(await response.json()).not.toHaveProperty('contacts');
  });
});