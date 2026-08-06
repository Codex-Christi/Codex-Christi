import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const FORMAT_PREFIX = 'ag1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const LEGACY_OPENSSL_PREFIX = Buffer.from('Salted__', 'ascii');

type ServerCipherOptions = {
  secret: string;
  purpose: string;
};

function contextFor(purpose: string): Buffer {
  return Buffer.from(`codex-christi/server-aes-gcm/v1/${purpose}`, 'utf8');
}

function deriveKey({ secret, purpose }: ServerCipherOptions): Buffer {
  return createHmac('sha256', secret).update(contextFor(purpose)).digest();
}

function parseBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url data');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('Non-canonical base64url data');
  }

  return decoded;
}

export function encryptServerText(plaintext: string, options: ServerCipherOptions): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(options), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(contextFor(options.purpose));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${FORMAT_PREFIX}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptServerText(value: string, options: ServerCipherOptions): string {
  const parts = value.split('.');
  const [prefix, encodedIv, encodedCiphertext, encodedAuthTag] = parts;

  if (
    parts.length !== 4 ||
    prefix !== FORMAT_PREFIX ||
    !encodedIv ||
    encodedCiphertext === undefined ||
    !encodedAuthTag
  ) {
    throw new Error('Unsupported server ciphertext format');
  }

  const iv = parseBase64Url(encodedIv);
  const ciphertext = encodedCiphertext ? parseBase64Url(encodedCiphertext) : Buffer.alloc(0);
  const authTag = parseBase64Url(encodedAuthTag);

  if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error('Invalid AES-GCM parameters');
  }

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(options), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(contextFor(options.purpose));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function deriveLegacyCryptoJsKeyAndIv(passphrase: string, salt: Buffer) {
  const password = Buffer.from(passphrase, 'utf8');
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);

  while (blocks.length < 3) {
    previous = createHash('md5')
      .update(Buffer.concat([previous, password, salt]))
      .digest();
    blocks.push(previous);
  }

  const derived = Buffer.concat(blocks);
  return {
    key: derived.subarray(0, 32),
    iv: derived.subarray(32, 48),
  };
}

/** Decrypts the OpenSSL-compatible passphrase format emitted by CryptoJS.AES.encrypt. */
export function decryptLegacyCryptoJsText(value: string, passphrase: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Invalid legacy CryptoJS base64');
  }

  const payload = Buffer.from(value, 'base64');

  if (payload.toString('base64') !== value) {
    throw new Error('Non-canonical legacy CryptoJS base64');
  }

  if (
    payload.byteLength <= LEGACY_OPENSSL_PREFIX.byteLength + 8 ||
    !payload.subarray(0, LEGACY_OPENSSL_PREFIX.byteLength).equals(LEGACY_OPENSSL_PREFIX)
  ) {
    throw new Error('Unsupported legacy CryptoJS ciphertext');
  }

  const salt = payload.subarray(LEGACY_OPENSSL_PREFIX.byteLength, 16);
  const ciphertext = payload.subarray(16);
  const { key, iv } = deriveLegacyCryptoJsKeyAndIv(passphrase, salt);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptServerTextWithLegacyCryptoJs(
  value: string,
  options: ServerCipherOptions,
): string {
  return value.startsWith(`${FORMAT_PREFIX}.`)
    ? decryptServerText(value, options)
    : decryptLegacyCryptoJsText(value, options.secret);
}
