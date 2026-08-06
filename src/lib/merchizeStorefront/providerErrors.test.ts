import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMerchizeJson, MerchizeProviderError } from './providerErrors';

test('an opt-in Merchize request timeout aborts and remains a transient provider error', async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | null | undefined;

  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal;
    return new Promise<Response>((_, reject) => {
      if (!observedSignal) {
        reject(new Error('Expected the bounded request to include an abort signal.'));
        return;
      }
      observedSignal.addEventListener(
        'abort',
        () => reject(observedSignal?.reason ?? new Error('Request aborted.')),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      fetchMerchizeJson('https://example.invalid/merchize', undefined, { timeoutMs: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof MerchizeProviderError);
        assert.equal(error.kind, 'network');
        assert.match(error.message, /timed out after 5ms/);
        return true;
      },
    );
    assert.equal(observedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
