import '../setup.js';
import { encryptionUtil } from '../../src/utils/encryption.js';

describe('utils/encryption (AES-256-GCM for stored bank account numbers)', () => {
  test('encrypt/decrypt round-trips the original value', () => {
    const plain = '0123456789012';
    const encrypted = encryptionUtil.encrypt(plain);
    expect(encrypted).not.toEqual(plain);
    expect(encryptionUtil.decrypt(encrypted)).toBe(plain);
  });

  test('ciphertext is not stored in plain text (contains iv:tag:data hex segments)', () => {
    const encrypted = encryptionUtil.encrypt('secret-account-number');
    expect(encrypted.split(':').length).toBe(3);
  });

  test('tampered ciphertext fails to decrypt (GCM auth tag check)', () => {
    const encrypted = encryptionUtil.encrypt('another-account-number');
    const [iv, tag, data] = encrypted.split(':');
    const tampered = [iv, tag, data.slice(0, -2) + '00'].join(':');
    expect(() => encryptionUtil.decrypt(tampered)).toThrow();
  });
});
