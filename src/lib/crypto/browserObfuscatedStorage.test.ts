import assert from 'node:assert/strict';
import test from 'node:test';
import type { StorageValue } from 'zustand/middleware';
import {
  createBrowserObfuscatedJSONStorage,
  obfuscateBrowserText,
  revealBrowserText,
  revealLegacyCryptoJsBrowserText,
} from './browserObfuscatedStorage';

const KEY = 'public-test-key';
const LEGACY_STATE =
  'U2FsdGVkX18AAQIDBAUGBwNuQX0aT87S3Oc9ucyjcbjKxOz+AWl1u9Wzc1ezPTBYnK6t1FLi6jFZ1JJatVh9xQ==';
const LEGACY_WISHLIST =
  'U2FsdGVkX18ICQoLDA0OD9OR7X4ICgeWFYfamyO+6w1WTIkwvtjKtwBWcC7jBlJ9cUiJVp2oL7UVWjUqnHT+UWszvfnlVnoCoDnyi9sV8Xg=';
const LEGACY_SENSITIVE =
  'U2FsdGVkX18AAQIDBAUGBwNuQX0aT87S3Oc9ucyjcbjADHJS6aQImeEfhcSmPDmeQAUEWnkbWea5ueqyWVTwNXYX2wXm+oCgzuJh4MkFm8I+kdcx5Pq0mBd4Ds5a6OD0lSjjo0dNTB0MXeqgLdxmPw==';

class MemoryStorage extends Map<string, string> implements Storage {
  get length() {
    return this.size;
  }
  getItem(key: string) {
    return this.get(key) ?? null;
  }
  key(index: number) {
    return [...this.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.delete(key);
  }
  setItem(key: string, value: string) {
    this.set(key, value);
  }
}

type AdapterOptions<S> = {
  legacyEncryptedStateFields?: string[];
  sanitize?: (value: StorageValue<S>) => StorageValue<S> | null;
};

function createAdapter<S>(storage: Storage, purpose: string, options: AdapterOptions<S> = {}) {
  return createBrowserObfuscatedJSONStorage<S>({
    getStorage: () => storage,
    publicKey: KEY,
    purpose,
    ...options,
  });
}

test('AES-GCM uses fresh IVs and rejects tampering or another purpose', async () => {
  const first = await obfuscateBrowserText('persisted state', KEY, 'unit-test');
  const second = await obfuscateBrowserText('persisted state', KEY, 'unit-test');
  const parts = first.split('.');
  parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;

  assert.notEqual(first, second);
  assert.equal(await revealBrowserText(first, KEY, 'unit-test'), 'persisted state');
  await assert.rejects(() => revealBrowserText(parts.join('.'), KEY, 'unit-test'));
  await assert.rejects(() => revealBrowserText(first, KEY, 'another-purpose'));
});

test('legacy CryptoJS ciphertext remains readable', async () => {
  assert.equal(
    await revealLegacyCryptoJsBrowserText(LEGACY_STATE, KEY),
    JSON.stringify({ state: { value: 'legacy' }, version: 0 }),
  );
});

test('adapter migrates whole-store and nested-field CryptoJS data', async (t) => {
  const cases = [
    {
      purpose: 'whole-store',
      stored: LEGACY_STATE,
      fields: undefined,
      expected: { state: { value: 'legacy' }, version: 0 },
    },
    {
      purpose: 'nested-store',
      stored: JSON.stringify({ state: { wishlist: LEGACY_WISHLIST }, version: 0 }),
      fields: ['wishlist'],
      expected: {
        state: { wishlist: { status: 200, success: true, message: 'ok', data: [] } },
        version: 0,
      },
    },
  ];

  for (const { purpose, stored, fields, expected } of cases) {
    await t.test(purpose, async () => {
      const storage = new MemoryStorage([[purpose, stored]]);
      const adapter = createAdapter<Record<string, unknown>>(storage, purpose, {
        legacyEncryptedStateFields: fields,
      });

      assert.deepEqual(await adapter.getItem(purpose), expected);
      assert.match(storage.getItem(purpose) ?? '', /^ob1\./u);
    });
  }
});

test('queued writes preserve order and removal waits for encryption', async () => {
  const storage = new MemoryStorage();
  const adapter = createAdapter<{ value: number }>(storage, 'queue');

  await Promise.all([
    adapter.setItem('queue', { state: { value: 1 }, version: 0 }),
    adapter.setItem('queue', { state: { value: 2 }, version: 0 }),
  ]);
  assert.deepEqual(await adapter.getItem('queue'), { state: { value: 2 }, version: 0 });

  void adapter.setItem('queue', { state: { value: 3 }, version: 0 });
  await adapter.removeItem('queue');
  assert.equal(storage.getItem('queue'), null);
});

test('concurrent mutations win over current and legacy hydration', async (t) => {
  for (const legacy of [false, true]) {
    await t.test(legacy ? 'legacy' : 'current', async () => {
      const purpose = `${legacy ? 'legacy' : 'current'}-race`;
      const oldState = JSON.stringify({ state: { value: 'old' }, version: 0 });
      const stored = legacy ? LEGACY_STATE : await obfuscateBrowserText(oldState, KEY, purpose);
      const storage = new MemoryStorage([[purpose, stored]]);
      const adapter = createAdapter<{ value: string }>(storage, purpose);

      const hydration = adapter.getItem(purpose);
      const write = adapter.setItem(purpose, { state: { value: 'new' }, version: 0 });
      assert.equal(await hydration, null);
      await write;
      assert.deepEqual(await adapter.getItem(purpose), {
        state: { value: 'new' },
        version: 0,
      });
    });
  }
});

test('sanitizer protects both migration and failed follow-up reads', async (t) => {
  type SensitiveState = { value: string; secret?: string };
  const sanitize = (value: StorageValue<SensitiveState>): StorageValue<SensitiveState> => ({
    ...value,
    state: { value: value.state.value },
  });
  const expected = { state: { value: 'legacy' }, version: 0 };

  await t.test('legacy rewrite', async () => {
    const purpose = 'sanitize-legacy';
    const storage = new MemoryStorage([[purpose, LEGACY_SENSITIVE]]);
    const adapter = createAdapter<SensitiveState>(storage, purpose, { sanitize });

    assert.deepEqual(await adapter.getItem(purpose), expected);
    const migrated = storage.getItem(purpose) ?? '';
    assert.match(migrated, /^ob1\./u);
    assert.doesNotMatch(await revealBrowserText(migrated, KEY, purpose), /4111111111111111/u);
  });

  await t.test('second read denied', async () => {
    const purpose = 'sanitize-read-failure';
    const unsafe = { state: { value: 'legacy', secret: '4111111111111111' }, version: 0 };
    const storage = new MemoryStorage([
      [purpose, await obfuscateBrowserText(JSON.stringify(unsafe), KEY, purpose)],
    ]);
    const originalGet = storage.getItem.bind(storage);
    let reads = 0;
    storage.getItem = (key) => {
      if ((reads += 1) > 1) throw new DOMException('Denied', 'SecurityError');
      return originalGet(key);
    };

    assert.deepEqual(
      await createAdapter<SensitiveState>(storage, purpose, { sanitize }).getItem(purpose),
      expected,
    );
  });
});

test('denied storage methods fail safely', async () => {
  const storage = new MemoryStorage();
  storage.getItem = () => {
    throw new DOMException('Denied', 'SecurityError');
  };
  storage.removeItem = () => {
    throw new DOMException('Denied', 'SecurityError');
  };
  const adapter = createAdapter<{ value: string }>(storage, 'denied');

  assert.equal(await adapter.getItem('denied'), null);
  await adapter.removeItem('denied');
});
