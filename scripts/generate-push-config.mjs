import webpush from 'web-push';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const keys=webpush.generateVAPIDKeys();
// Secret values are written once to an ignored file and never printed.
writeFileSync('.env.push.local',`WEB_PUSH_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_PRIVATE_KEY=${keys.privateKey}\nWEB_PUSH_SUBJECT=mailto:lubricenterc@gmail.com\nFINANCE_JOB_SECRET=${randomBytes(32).toString('hex')}\n`,{flag:'wx',mode:0o600});
console.log('Configuración generada en .env.push.local. No subir este archivo a Git.');
