// Web Push (RFC 8030, VAPID RFC 8292, Payload Encryption RFC 8291).
// Pure Node crypto — no external dependencies needed beyond what we already have.
import { webcrypto, createHmac, randomBytes, createCipheriv } from 'node:crypto';

const enc = (s) => new TextEncoder().encode(s);

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Import the VAPID private key into a CryptoKey for signing
async function importVapidPrivate(privB64u) {
  const d = b64urlDecode(privB64u);
  // We also need the public key parts to build a proper JWK
  const pub = b64urlDecode(process.env.VAPID_PUBLIC_KEY);
  const x = b64url(pub.slice(1, 33));
  const y = b64url(pub.slice(33, 65));
  const jwk = { kty: 'EC', crv: 'P-256', d: b64url(d), x, y, ext: true };
  return webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// Build a VAPID Authorization header for a given push endpoint
async function vapidHeaders(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,  // 12 hours
    sub: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  })));
  const unsigned = header + '.' + payload;
  const key = await importVapidPrivate(process.env.VAPID_PRIVATE_KEY);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(unsigned));
  const jwt = unsigned + '.' + b64url(sig);
  return {
    Authorization: `vapid t=${jwt}, k=${process.env.VAPID_PUBLIC_KEY}`,
  };
}

// HKDF as specified for Web Push
function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const out = Buffer.alloc(length);
  let prev = Buffer.alloc(0);
  let pos = 0;
  let counter = 1;
  while (pos < length) {
    const h = createHmac('sha256', prk);
    h.update(prev);
    h.update(info);
    h.update(Buffer.from([counter]));
    prev = h.digest();
    prev.copy(out, pos);
    pos += prev.length;
    counter++;
  }
  return out;
}

// Encrypt the payload for a subscriber per RFC 8291 (aes128gcm content encoding)
async function encryptPayload(payload, subscription) {
  const clientPubBuf = b64urlDecode(subscription.keys.p256dh);
  const authSecret  = b64urlDecode(subscription.keys.auth);

  // Generate a fresh ECDH keypair for this message
  const serverKp = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPubRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', serverKp.publicKey));

  // Import the client public key for ECDH
  const clientPubKey = await webcrypto.subtle.importKey(
    'raw', clientPubBuf, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = Buffer.from(await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPubKey }, serverKp.privateKey, 256
  ));

  // PRK_key = HKDF(authSecret, ecdhSecret, "WebPush: info\0" || clientPub || serverPub, 32)
  const keyInfo = Buffer.concat([
    enc('WebPush: info\0'),
    clientPubBuf,
    serverPubRaw,
  ]);
  const prkKey = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = randomBytes(16);
  const cek = hkdf(salt, prkKey, Buffer.concat([enc('Content-Encoding: aes128gcm\0')]), 16);
  const nonce = hkdf(salt, prkKey, Buffer.concat([enc('Content-Encoding: nonce\0')]), 12);

  // Payload framing: data || 0x02 (final record delimiter)
  const data = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  // Body: salt(16) || rs(4 = 4096) || idlen(1) || serverPub(65) || ciphertext
  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 16, 0]),  // record size 4096
    Buffer.from([serverPubRaw.length]),
    serverPubRaw,
  ]);
  return Buffer.concat([header, ct]);
}

export async function sendPush(subscription, payload, opts = {}) {
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
    return { ok: false, status: 0, error: 'VAPID keys not configured' };
  }
  const body = await encryptPayload(payload, subscription);
  const vapid = await vapidHeaders(subscription.endpoint);
  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...vapid,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(opts.ttl ?? 3600),
      'Urgency': opts.urgency ?? 'normal',
    },
    body,
  });
  return { ok: resp.ok, status: resp.status };
}
