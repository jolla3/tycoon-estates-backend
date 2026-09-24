// src/utils/encryption.js
//
// AES-256-GCM for sensitive stored configuration — primarily
// BankAccount.accountNumberEncrypted (section 24/30). ENCRYPTION_KEY must
// be a 32-byte value expressed as 64 hex characters.

import crypto from 'crypto';
import { env } from '../config/environment.js';

function keyBuffer() {
  return Buffer.from(env.ENCRYPTION_KEY.padEnd(64, '0').slice(0, 64), 'hex');
}

export const encryptionUtil = {
  /**
   * Deterministic HMAC-SHA256 of a value, for lookups (e.g. "which
   * BankAccount does this account number belong to"). NOT reversible —
   * this is a lookup key, not a substitute for encrypt()/decrypt(). Uses
   * the same ENCRYPTION_KEY as the HMAC secret; if you ever rotate that
   * key, existing hashes stop matching, so plan a re-hash migration
   * alongside any key rotation.
   */
  hashForLookup(plainText) {
    return crypto.createHmac('sha256', keyBuffer()).update(String(plainText)).digest('hex');
  },

  encrypt(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  },
  decrypt(payload) {
    const [ivHex, tagHex, dataHex] = String(payload).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  },
};
