// Must be imported BEFORE any module that reads src/config/environment.js.
process.env.G5_PROTECTED_SMS_ENABLED = '1';
process.env.G5_ENVELOPE_KEYS ||= `k1:${'a1'.repeat(32)}`;
process.env.G5_EVIDENCE_DIGEST_KEY ||= 'd4'.repeat(32);
process.env.G5_LINK_TOKEN_PEPPER ||= 'c3'.repeat(32);
