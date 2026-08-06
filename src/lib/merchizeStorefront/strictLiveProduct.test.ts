import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchStrictLiveStorefrontProductDetails } from './strictLiveProduct';

test('strict storefront reads use no-store, a deadline, and cross-check product identity', async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.MERCHIZE_BASE_URL;
  const originalApiKey = process.env.MERCHIZE_API_KEY;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  process.env.MERCHIZE_BASE_URL = 'https://storefront.example';
  process.env.MERCHIZE_API_KEY = 'test-key';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = url.endsWith('/all-variants')
      ? {
          success: true,
          data: [
            {
              _id: 'variant-1',
              product: 'product-1',
              sku: 'STORE-SKU-1',
              title: 'Medium',
              retail_price: 20,
              image_uris: [],
              is_default: true,
              options: [],
            },
          ],
        }
      : {
          data: {
            _id: 'product-1',
            slug: 'product-one',
            title: 'Product One',
            description: '',
            image: '',
            retail_price: '20',
          },
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const details = await fetchStrictLiveStorefrontProductDetails('product-1');
    assert.equal(details.product._id, 'product-1');
    assert.equal(details.variants[0]._id, 'variant-1');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.init?.cache === 'no-store'));
    assert.ok(calls.every((call) => call.init?.signal instanceof AbortSignal));

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = url.endsWith('/all-variants')
        ? {
            data: [
              {
                _id: 'variant-1',
                product: 'different-product',
                sku: 'STORE-SKU-1',
                title: 'Medium',
                retail_price: 20,
                image_uris: [],
                is_default: true,
                options: [],
              },
            ],
          }
        : {
            data: {
              _id: 'product-1',
              slug: 'product-one',
              title: 'Product One',
              retail_price: '20',
            },
          };
      void init;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      () => fetchStrictLiveStorefrontProductDetails('product-1'),
      /mismatched product identity/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.MERCHIZE_BASE_URL;
    else process.env.MERCHIZE_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete process.env.MERCHIZE_API_KEY;
    else process.env.MERCHIZE_API_KEY = originalApiKey;
  }
});
