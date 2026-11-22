// Tenant link-token envelope. The key is purpose-derived from the existing
// dedicated G5 keyring so link tokens do not reuse the G5 SMS/evidence AEAD key.
import crypto from 'crypto';

const VERSION = 'g5lt1';
const INFO = Buffer.from('tycoon-estates:g5:mpesa-link-token:v1', 'utf8');
const SALT = Buffer.from('tycoon-estates:g5-link-token-envelope', 'utf8');

function keyring() {
  const raw = process.env.G5_ENVELOPE_KEYS || '';
  const keys = new Map();
  let activeId = null;
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, hex, ...rest] = item.split(':');
    if (rest.length || !/^[A-Za-z0-9_-]{1,16}$/.test(id || '') || !/^[0-9a-fA-F]{64}$/.test(hex || '')) {
      const err = new Error('G5_ENVELOPE_KEYS entry is malformed');
      err.code = 'G5_LINK_TOKEN_KEY_INVALID';
      throw err;
    }
    if (keys.has(id)) {
      const err = new Error('G5_ENVELOPE_KEYS contains a duplicate key id');
      err.code = 'G5_LINK_TOKEN_KEY_INVALID';
      throw err;
    }
    keys.set(id, Buffer.from(hex, 'hex'));
    if (!activeId) activeId = id;
  }
  if (!activeId) {
    const err = new Error('G5_ENVELOPE_KEYS is required for reusable tenant payment links');
    err.code = 'G5_LINK_TOKEN_KEY_MISSING';
    throw err;
  }
  return { keys, activeId };
}

function derive(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, SALT, INFO, 32));
}

function aadFor(context) {
  const required = ['linkId', 'clientId', 'estateId', 'tenantId', 'linkVersion'];
  if (!context || required.some((key) => context[key] == null || String(context[key]).length === 0)) {
    const err = new Error('Tenant link token encryption context is incomplete');
    err.code = 'G5_LINK_TOKEN_AAD_INVALID';
    throw err;
  }
  return Buffer.from([
    'g5-link-token', 'v1', String(context.linkId), String(context.clientId),
    String(context.estateId), String(context.tenantId), String(context.linkVersion),
  ].join(':'), 'utf8');
}

function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) throw new Error('Invalid link-token envelope encoding');
  return Buffer.from(value, 'base64url');
}

export function sealLinkToken(token, context) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    const err = new Error('Invalid tenant payment token');
    err.code = 'G5_LINK_TOKEN_INVALID';
    throw err;
  }
  const { keys, activeId } = keyring();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(keys.get(activeId)), iv);
  cipher.setAAD(aadFor(context));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, activeId, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
}

export function openLinkToken(envelope, context) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 5 || parts[0] !== VERSION || !/^[A-Za-z0-9_-]{1,16}$/.test(parts[1])) {
    const err = new Error('Unsupported tenant link token envelope');
    err.code = 'G5_LINK_TOKEN_ENVELOPE_INVALID';
    throw err;
  }
  const { keys } = keyring();
  const master = keys.get(parts[1]);
  if (!master) {
    const err = new Error('Tenant link token encryption key is unavailable');
    err.code = 'G5_LINK_TOKEN_KEY_UNKNOWN';
    throw err;
  }
  const iv = unb64(parts[2]);
  const tag = unb64(parts[3]);
  const ciphertext = unb64(parts[4]);
  if (iv.length !== 12 || tag.length !== 16) {
    const err = new Error('Malformed tenant link token envelope');
    err.code = 'G5_LINK_TOKEN_ENVELOPE_INVALID';
    throw err;
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', derive(master), iv);
  decipher.setAAD(aadFor(context));
  decipher.setAuthTag(tag);
  let token;
  try {
    token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    const err = new Error('Tenant link token authentication failed');
    err.code = 'G5_LINK_TOKEN_AUTH_FAILED';
    throw err;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    const err = new Error('Decrypted tenant link token is malformed');
    err.code = 'G5_LINK_TOKEN_INVALID';
    throw err;
  }
  return token;
}
