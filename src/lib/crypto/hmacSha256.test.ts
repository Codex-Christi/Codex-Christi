import assert from 'node:assert/strict';
import test from 'node:test';
import { hmacSha256Hex } from './hmacSha256';

test('native HMAC-SHA256 remains byte-compatible with CryptoJS hex output', () => {
  assert.equal(
    hmacSha256Hex('1700000000', 'test-secret'),
    '1b74eaf87da46877ba651ac812b24a3bf01990e9ed0101b88268f60f965729e2',
  );
});
