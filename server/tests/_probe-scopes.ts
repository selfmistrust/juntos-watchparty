import { scopesDoToken } from '../src/spotifyOAuth.js';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = b64({ alg: 'none' }) + '.' + b64({ scope: 'streaming user-read-email user-read-private' }) + '.assinatura';
console.log('scopos lidos: ' + JSON.stringify(scopesDoToken(token)));
console.log('sem scope:    ' + JSON.stringify(scopesDoToken(b64({}) + '.' + b64({}) + '.x')));
console.log('lixo:         ' + JSON.stringify(scopesDoToken('nao-e-jwt')));
