// Ammetid push: sender notifikationer ved 10, 15 og 25 minutter, også når telefonen er låst.
// Gemmer kun push-adressen, starttidspunktet og en kort tekst (fx "Venstre 1/2") – og kun indtil amningen slutter.
// Én Durable Object pr. telefon; dens alarm vækker den præcist, når næste besked skal sendes.

import { DurableObject } from 'cloudflare:workers';

const ORIGIN = 'https://danielbalsby.github.io';
const STEPS = [10, 15, 25, 27, 29];               // 27 og 29: alarmen gentages, hvis ingen har svaret
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const SUBJECT = 'https://danielbalsby.github.io/boobielicious/';

const cors = origin => ({
  'Access-Control-Allow-Origin': origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin) ? origin : ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const { pathname } = new URL(req.url);
    if (req.method !== 'POST' || !['/schedule', '/cancel', '/test'].includes(pathname)) return new Response('Ammetid', { headers: h });

    let body;
    try { body = await req.json(); } catch { return new Response('bad json', { status: 400, headers: h }); }
    const sub = body.sub;
    if (!validSub(sub)) return new Response('bad subscription', { status: 400, headers: h });

    const stub = env.FEEDS.get(env.FEEDS.idFromName(sub.endpoint));
    const res = await stub.handle(pathname, body);
    return new Response(JSON.stringify(res), { status: res.ok ? 200 : 400, headers: { ...h, 'Content-Type': 'application/json' } });
  },
};

function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname)
      && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
  } catch { return false; }
}

export class Feed extends DurableObject {
  async handle(path, body) {
    if (path === '/cancel') {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { ok: true };
    }
    if (path === '/test') {
      const status = await sendPush(this.env, body.sub, { title: 'Ammetid', body: 'Notifikationer virker. Sådan ser de ud ved 10 og 15 minutter.', tag: 'ammetid-test' });
      return { ok: status < 300, status };
    }
    const start = Number(body.start);
    if (!Number.isFinite(start) || Math.abs(Date.now() - start) > 3 * 3600e3) return { ok: false };
    const label = String(body.label || '').slice(0, 40);
    await this.ctx.storage.put('feed', { sub: body.sub, start, label });
    await this.arm(start);
    return { ok: true };
  }

  async arm(start) {
    const next = STEPS.map(m => start + m * 60e3).find(t => t > Date.now());
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const feed = await this.ctx.storage.get('feed');
    if (!feed) return;
    const min = Math.round((Date.now() - feed.start) / 60e3);
    const step = [...STEPS].reverse().find(m => min >= m);
    if (step && min - step < 2) {                  // send ikke gamle beskeder, hvis vi er blevet forsinket
      const status = await sendPush(this.env, feed.sub, message(step, feed.label));
      if (status === 404 || status === 410) { await this.ctx.storage.deleteAll(); return; }   // abonnementet findes ikke længere
    }
    await this.arm(feed.start);
  }
}

function message(m, label) {
  const side = label ? ` · ${label}` : '';
  if (m < 25) return { title: `${m} minutter`, body: `Amningen har varet ${m} min${side}`, tag: 'ammetid' };
  return { title: 'Er du vågen?', body: `Amningen har varet ${m} min. Åbn Ammetid og tryk “Jeg er vågen”.`, tag: 'ammetid', alarm: true };
}

// ---------- Web Push (RFC 8291 kryptering + VAPID, kun WebCrypto) ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encrypt(payload, sub) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(enc.encode(payload), new Uint8Array([2]));          // 2 = sidste (og eneste) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPub, cipher);
}

export async function vapid(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  const pub = b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
}

async function sendPush(env, sub, msg) {
  const body = await encrypt(JSON.stringify(msg), sub);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapid(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '120',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
