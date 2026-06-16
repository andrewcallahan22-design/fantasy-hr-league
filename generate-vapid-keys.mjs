// Generates a VAPID keypair for Web Push notifications.
// Run ONCE with: node generate-vapid-keys.mjs
// Copy the two values it prints into Netlify env vars (instructions in README).
import { webcrypto } from 'node:crypto';

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

// Public key: 65-byte uncompressed point, base64url encoded
const pubRaw = await webcrypto.subtle.exportKey('raw', publicKey);
const pub = Buffer.from(pubRaw).toString('base64url');

// Private key: 32-byte scalar, base64url encoded
const privJwk = await webcrypto.subtle.exportKey('jwk', privateKey);
const priv = privJwk.d;

console.log('\nCopy these into Netlify → Site configuration → Environment variables:\n');
console.log('  VAPID_PUBLIC_KEY  =', pub);
console.log('  VAPID_PRIVATE_KEY =', priv);
console.log('  VAPID_SUBJECT     = mailto:andrewcallahan22@gmail.com\n');
console.log('Then trigger a fresh deploy and notifications will work.\n');
