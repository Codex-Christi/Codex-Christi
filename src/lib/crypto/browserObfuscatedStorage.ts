import type { PersistStorage, StorageValue } from 'zustand/middleware';

const FORMAT_PREFIX = 'ob1';
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

type BrowserObfuscatedStorageOptions = {
  getStorage: () => Storage;
  /** Public browser keys provide obfuscation and corruption detection, not trusted security. */
  publicKey: string | undefined;
  purpose: string;
  /** Fields that CryptoJS encrypted inside an otherwise JSON Zustand value. */
  legacyEncryptedStateFields?: string[];
};

type BrowserObfuscatedStorageTypedOptions<S> = BrowserObfuscatedStorageOptions & {
  sanitize?: (value: StorageValue<S>) => StorageValue<S> | null;
};

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64ToBytes(value: string, urlSafe = false): Uint8Array<ArrayBuffer> {
  const pattern = urlSafe ? /^[A-Za-z0-9_-]+$/u : /^[A-Za-z0-9+/]+={0,2}$/u;
  if (!pattern.test(value))
    throw new Error(urlSafe ? 'Invalid base64url data' : 'Invalid base64 data');
  const base64 = urlSafe ? value.replaceAll('-', '+').replaceAll('_', '/') : value;
  return binaryToBytes(atob(base64 + (urlSafe ? '='.repeat((4 - (base64.length % 4)) % 4) : '')));
}

function concatBytes(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
  return globalThis.crypto;
}

function getKey(publicKey: string, purpose: string): Promise<CryptoKey> {
  const cacheKey = `${purpose}\u0000${publicKey}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const cryptoApi = getCrypto();
  const material = encoder.encode(
    `codex-christi/browser-obfuscation/v1/${purpose}\u0000${publicKey}`,
  );
  const key = cryptoApi.subtle
    .digest('SHA-256', material)
    .then((digest) =>
      cryptoApi.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    );

  keyCache.set(cacheKey, key);
  void key.catch(() => keyCache.delete(cacheKey));
  return key;
}

export async function obfuscateBrowserText(
  plaintext: string,
  publicKey: string,
  purpose: string,
): Promise<string> {
  const cryptoApi = getCrypto();
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await getKey(publicKey, purpose),
    encoder.encode(plaintext),
  );

  return `${FORMAT_PREFIX}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function revealBrowserText(
  value: string,
  publicKey: string,
  purpose: string,
): Promise<string> {
  const [prefix, encodedIv, encodedCiphertext, ...extra] = value.split('.');
  if (prefix !== FORMAT_PREFIX || !encodedIv || !encodedCiphertext || extra.length) {
    throw new Error('Unsupported browser storage format');
  }

  const iv = base64ToBytes(encodedIv, true);
  if (iv.length !== IV_BYTES) throw new Error('Invalid AES-GCM IV');
  const plaintext = await getCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv },
    await getKey(publicKey, purpose),
    base64ToBytes(encodedCiphertext, true),
  );
  return decoder.decode(plaintext);
}

/** Reads CryptoJS's OpenSSL passphrase format solely to migrate it to AES-GCM. */
export async function revealLegacyCryptoJsBrowserText(
  value: string,
  passphrase: string,
): Promise<string> {
  const { md5 } = await import('@noble/hashes/legacy');
  const payload = base64ToBytes(value);
  const prefix = encoder.encode('Salted__');
  if (payload.length <= 16 || !prefix.every((byte, index) => payload[index] === byte)) {
    throw new Error('Unsupported legacy CryptoJS ciphertext');
  }

  const salt = payload.slice(8, 16);
  const password = encoder.encode(passphrase);
  let block = new Uint8Array(0);
  let derived = new Uint8Array(0);

  // CryptoJS used OpenSSL EVP_BytesToKey with MD5. MD5 is never used for new data.
  while (derived.length < 48) {
    block = new Uint8Array(md5(concatBytes(block, password, salt)));
    derived = concatBytes(derived, block);
  }

  const cryptoApi = getCrypto();
  const key = await cryptoApi.subtle.importKey(
    'raw',
    derived.slice(0, 32),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plaintext = await cryptoApi.subtle.decrypt(
    { name: 'AES-CBC', iv: derived.slice(32, 48) },
    key,
    payload.slice(16),
  );
  return decoder.decode(plaintext);
}

async function decodeStoredValue<S>(
  stored: string,
  publicKey: string,
  purpose: string,
  legacyFields?: string[],
): Promise<[StorageValue<S>, boolean]> {
  if (stored.startsWith(`${FORMAT_PREFIX}.`)) {
    return [
      JSON.parse(await revealBrowserText(stored, publicKey, purpose)) as StorageValue<S>,
      false,
    ];
  }

  if (!legacyFields?.length) {
    return [
      JSON.parse(await revealLegacyCryptoJsBrowserText(stored, publicKey)) as StorageValue<S>,
      true,
    ];
  }

  const value = JSON.parse(stored) as StorageValue<S>;
  const state = value?.state as Record<string, unknown> | undefined;
  if (!state) throw new Error('Invalid legacy Zustand state');
  for (const field of legacyFields) {
    if (typeof state[field] === 'string') {
      state[field] = JSON.parse(
        await revealLegacyCryptoJsBrowserText(state[field] as string, publicKey),
      ) as unknown;
    }
  }
  return [value, true];
}

function safely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/** Async Zustand storage with AES-GCM writes and transparent CryptoJS migration. */
export function createBrowserObfuscatedJSONStorage<S>({
  getStorage,
  publicKey,
  purpose,
  legacyEncryptedStateFields,
  sanitize,
}: BrowserObfuscatedStorageTypedOptions<S>): PersistStorage<S, Promise<void>> {
  let writeQueue = Promise.resolve();
  let generation = 0;

  const superseded = async (startedAt: number) => {
    if (startedAt === generation) return false;
    await writeQueue;
    return true;
  };
  const enqueue = (operation: () => void | Promise<void>) => {
    generation += 1;
    writeQueue = writeQueue.then(operation).catch(() => undefined);
    return writeQueue;
  };

  return {
    getItem: async (name) => {
      for (;;) {
        const startedAt = generation;
        const pendingWrites = writeQueue;
        await pendingWrites;
        if (await superseded(startedAt)) return null;

        const storage = safely(getStorage);
        if (!storage || !publicKey) return null;
        const stored = safely(() => storage.getItem(name));
        if (!stored) return null;

        let decoded: StorageValue<S>;
        let legacy: boolean;
        try {
          [decoded, legacy] = await decodeStoredValue(
            stored,
            publicKey,
            purpose,
            legacyEncryptedStateFields,
          );
        } catch {
          if (await superseded(startedAt)) return null;
          const latest = safely(() => storage.getItem(name));
          if (latest !== undefined && latest !== stored) continue;
          void safely(() => storage.removeItem(name));
          return null;
        }

        if (await superseded(startedAt)) return null;
        let safeValue: StorageValue<S> | null;
        try {
          safeValue = sanitize ? sanitize(decoded) : decoded;
        } catch {
          void safely(() => storage.removeItem(name));
          return null;
        }
        if (!safeValue) {
          void safely(() => storage.removeItem(name));
          return null;
        }

        const latest = safely(() => storage.getItem(name));
        if (latest === undefined) return safeValue;
        if (latest !== stored) continue;

        const safeJson = JSON.stringify(safeValue);
        if (legacy || JSON.stringify(decoded) !== safeJson) {
          try {
            const migrated = await obfuscateBrowserText(safeJson, publicKey, purpose);
            if (await superseded(startedAt)) return null;
            const beforeRewrite = safely(() => storage.getItem(name));
            if (beforeRewrite === undefined) return safeValue;
            if (beforeRewrite !== stored) continue;
            storage.setItem(name, migrated);
          } catch {
            // Valid state may still hydrate when storage is temporarily unavailable or full.
          }
        }
        return safeValue;
      }
    },
    setItem: (name, value) =>
      enqueue(async () => {
        const storage = safely(getStorage);
        if (!storage || !publicKey) return;
        storage.setItem(
          name,
          await obfuscateBrowserText(JSON.stringify(value), publicKey, purpose),
        );
      }),
    removeItem: (name) =>
      enqueue(() => {
        const storage = safely(getStorage);
        if (storage) void safely(() => storage.removeItem(name));
      }),
  };
}
