import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptLegacyCryptoJsText,
  decryptServerText,
  decryptServerTextWithLegacyCryptoJs,
  encryptServerText,
} from './serverAesGcm';

const options = {
  secret: 'test-only-server-secret',
  purpose: 'unit-test',
};

test('AES-GCM server ciphertext round-trips and uses a fresh IV', () => {
  const first = encryptServerText('payment payload', options);
  const second = encryptServerText('payment payload', options);

  assert.notEqual(first, second);
  assert.equal(decryptServerText(first, options), 'payment payload');
  assert.equal(decryptServerText(second, options), 'payment payload');
});

test('AES-GCM server ciphertext rejects tampering and purpose changes', () => {
  const encrypted = encryptServerText('payment payload', options);
  const parts = encrypted.split('.');
  parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
  const tampered = parts.join('.');

  assert.throws(() => decryptServerText(tampered, options));
  assert.throws(() =>
    decryptServerText(encrypted, {
      ...options,
      purpose: 'different-purpose',
    }),
  );
});

test('legacy CryptoJS OpenSSL ciphertext remains readable during rollout', () => {
  const legacyCiphertext = 'U2FsdGVkX18AAQIDBAUGBxv5oYpe5WnZ6RYGE+ErXjc=';

  assert.equal(decryptLegacyCryptoJsText(legacyCiphertext, 'test legacy secret'), 'legacy payload');
  assert.equal(
    decryptServerTextWithLegacyCryptoJs(legacyCiphertext, {
      secret: 'test legacy secret',
      purpose: 'unit-test',
    }),
    'legacy payload',
  );
});
