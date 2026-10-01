import {describe,it,expect} from 'vitest';
import {changeQuote} from '../lib/finance/change';
import {digestMessage,allowedPushEndpoint} from '../lib/finance/push';
describe('Commercial price, physical cash and change',()=>{
 it('preserves 40 USD agreed when the client tenders a 50 USD bill',()=>{expect(changeQuote(34000,50,'USD',850,1000)).toMatchObject({applied:'40.00',changeUsd:'10.00',coveredVes:'34000.00'});});
 it('uses the agreed conversion only for the Bs surplus',()=>{expect(changeQuote(34000,40000,'VES',850,1000)).toMatchObject({applied:'34000.00',changeUsd:'6.00'});});
 it('shows the signed cent-rounding adjustment instead of hiding it in sales',()=>{expect(changeQuote(34000,34001,'VES',850,800)).toMatchObject({changeUsd:'0.00',roundingVes:'1.00'});expect(changeQuote(34000,32000,'VES',850,800,40)).toMatchObject({applied:'32000.00',coveredVes:'34000.00'});});
 it('keeps partial payments partial and bounds decimal equivalence to the actual price',()=>{expect(changeQuote(32000,20,'USD',850,900).coveredVes).toBe('17000.00');expect(changeQuote(32000,37.65,'USD',850,900)).toMatchObject({changeUsd:'0.00',coveredVes:'32000.00'});});
 it('rejects missing rates, nonfinite values and fractions of a cent',()=>{for(const amount of ['NaN','Infinity','0','-1','1.001'])expect(()=>changeQuote(34000,amount,'USD',850,900)).toThrow();expect(()=>changeQuote(34000,50,'USD',850,0)).toThrow();});
 it('does not send a noise notification and does not expose names or amounts',()=>{expect(digestMessage({cash:0,opening_needed:false,exceptions:0,reports:0,refunds:0,role:'OWNER'})).toBeNull();expect(digestMessage({cash:1,opening_needed:false,exceptions:2,reports:1,refunds:1,role:'OWNER'})).toContain('vuelto(s)');});
 it('only sends to public known push providers',()=>{for(const url of ['http://fcm.googleapis.com/x','https://localhost/x','https://fcm.googleapis.com.evil.test/x','https://u:p@fcm.googleapis.com/x','https://127.0.0.1/x'])expect(allowedPushEndpoint(url)).toBe(false);expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/test')).toBe(true);});
});
