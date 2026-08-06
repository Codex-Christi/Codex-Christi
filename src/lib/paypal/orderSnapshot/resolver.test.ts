import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogItem } from '@/lib/datasetSearchers/merchize/catalog';
import {
  CANONICAL_ORDER_RESOLUTION_LIMITS,
  CanonicalOrderResolutionError,
  extractCanonicalOrderSelectionsFromCart,
  resolveCanonicalOrderSnapshot,
  type CanonicalOrderResolverDependencies,
} from './resolver';
import { calculateStrictShippingQuoteUsd } from './strictShipping';

const catalogRow: CatalogItem = {
  SKU_product: 'SUPPLIER',
  SKU_variant: 'TRUSTED-SKU',
  tier_1_price: null,
  tier_2_price: null,
  tier_3_price: null,
  US_shipping_fee: 6,
  US_additional_shipping_fee: 2,
  EU_shipping_fee: 8,
  EU_additional_shipping_fee: 3,
  GB_shipping_fee: 9,
  GB_additional_shipping_fee: 4,
  CA_shipping_fee: null,
  CA_additional_shipping_fee: null,
  AU_shipping_fee: 10,
  AU_additional_shipping_fee: 5,
  ROW_shipping_fee: 11,
  ROW_additional_shipping_fee: 6,
};

function dependencies(
  overrides: Partial<CanonicalOrderResolverDependencies> = {},
): CanonicalOrderResolverDependencies {
  return {
    resolveProduct: async () => ({
      productId: 'trusted-product',
      title: 'Trusted product title',
      variants: [
        {
          variantId: 'trusted-variant',
          productId: 'trusted-product',
          supplierProductId: 'supplier-product',
          supplierVariantId: 'supplier-variant',
          sku: 'TRUSTED-SKU',
          sellerSku: 'TRUSTED-SELLER-SKU',
          title: 'Medium',
          selectedOptions: [
            { name: 'Size', value: 'M' },
            { name: 'Color', value: 'Blue' },
          ],
          imageUrl: 'https://images.example/trusted.jpg',
          unitPriceUsd: 10,
          priceSource: 'live',
          isAvailable: true,
        },
      ],
      isAvailable: true,
    }),
    resolveCatalogVariants: async () => [
      {
        sku: 'TRUSTED-SKU',
        supplierProductId: 'supplier-product',
        supplierVariantId: 'supplier-variant',
        catalogRow,
      },
    ],
    resolveCurrency: async () => ({ currency: 'USD', multiplier: 1 }),
    resolveShipping: async ({ lines, catalogVariants, countryIso3 }) =>
      calculateStrictShippingQuoteUsd({
        lines,
        catalogRows: catalogVariants.map((variant) => variant.catalogRow),
        countryIso3,
      }),
    now: () => new Date('2026-08-06T12:00:00.000Z'),
    ...overrides,
  };
}

const input = {
  selections: [{ productId: 'browser-product-lookup', variantId: 'trusted-variant', quantity: 2 }],
  destination: { countryIso3: 'USA', region: 'CA' },
};

test('cart bridge ignores browser price, SKU, title, and option metadata', () => {
  const selections = extractCanonicalOrderSelectionsFromCart([
    {
      variantId: 'trusted-variant',
      quantity: 2,
      title: 'ATTACKER TITLE',
      itemDetail: {
        product: 'browser-product-lookup',
        retail_price: 0.01,
        sku: 'ATTACKER-SKU',
        sku_seller: 'ATTACKER-SELLER-SKU',
        options: [{ name: 'ATTACKER OPTION' }],
      },
    },
  ]);

  assert.deepEqual(selections, [
    { productId: 'browser-product-lookup', variantId: 'trusted-variant', quantity: 2 },
  ]);
});

test('builds one sealed snapshot only from trusted provider and catalog data', async () => {
  const snapshot = await resolveCanonicalOrderSnapshot(input, dependencies());

  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.subtotal.value, '20.00');
  assert.equal(snapshot.shipping.value, '10.00');
  assert.equal(snapshot.total.value, '30.00');
  assert.equal(snapshot.lines[0].productId, 'trusted-product');
  assert.equal(snapshot.lines[0].variantId, 'trusted-variant');
  assert.equal(snapshot.lines[0].supplierProductId, 'supplier-product');
  assert.equal(snapshot.lines[0].supplierVariantId, 'supplier-variant');
  assert.equal(snapshot.lines[0].sku, 'TRUSTED-SKU');
  assert.equal(snapshot.lines[0].sellerSku, 'TRUSTED-SELLER-SKU');
  assert.equal(snapshot.lines[0].title, 'Trusted product title');
  assert.equal(snapshot.lines[0].imageUrl, 'https://images.example/trusted.jpg');
  assert.equal('tax' in snapshot, false);
});

test('preserves supported multi-currency calculation in the canonical values', async () => {
  const snapshot = await resolveCanonicalOrderSnapshot(
    input,
    dependencies({ resolveCurrency: async () => ({ currency: 'EUR', multiplier: 0.9 }) }),
  );

  assert.equal(snapshot.currency, 'EUR');
  assert.equal(snapshot.lines[0].unitAmount.value, '9.00');
  assert.equal(snapshot.subtotal.value, '18.00');
  assert.equal(snapshot.shipping.value, '9.00');
  assert.equal(snapshot.total.value, '27.00');
});

test('emits PayPal-valid zero-digit HUF and TWD amounts', async () => {
  for (const currency of ['HUF', 'TWD']) {
    const snapshot = await resolveCanonicalOrderSnapshot(
      input,
      dependencies({ resolveCurrency: async () => ({ currency, multiplier: 100 }) }),
    );

    assert.equal(snapshot.currency, currency);
    assert.equal(snapshot.lines[0].unitAmount.value, '1000');
    assert.equal(snapshot.subtotal.value, '2000');
    assert.equal(snapshot.shipping.value, '1000');
    assert.equal(snapshot.total.value, '3000');
    assert.equal(snapshot.total.value.includes('.'), false);
  }
});

test('merges duplicate selections before sealing and produces a deterministic hash', async () => {
  const first = await resolveCanonicalOrderSnapshot(input, dependencies());
  const second = await resolveCanonicalOrderSnapshot(
    {
      ...input,
      selections: [
        { productId: 'browser-product-lookup', variantId: 'trusted-variant', quantity: 1 },
        { productId: 'browser-product-lookup', variantId: 'trusted-variant', quantity: 1 },
      ],
    },
    dependencies(),
  );

  assert.equal(second.lines.length, 1);
  assert.equal(second.lines[0].quantity, 2);
  assert.equal(second.hash, first.hash);
});

test('rejects a variant that is not returned by the selected server product', async () => {
  await assert.rejects(
    () =>
      resolveCanonicalOrderSnapshot(
        { ...input, selections: [{ ...input.selections[0], variantId: 'made-up' }] },
        dependencies(),
      ),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'VARIANT_UNAVAILABLE',
  );
});

test('rejects trusted products marked hidden, draft, retired, or otherwise unavailable', async () => {
  const deps = dependencies();
  const original = deps.resolveProduct;
  deps.resolveProduct = async (lookup) => ({
    ...(await original(lookup)),
    isAvailable: false,
  });

  await assert.rejects(
    () => resolveCanonicalOrderSnapshot(input, deps),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'PRODUCT_UNAVAILABLE',
  );
});

test('rejects trusted variants marked unavailable', async () => {
  const deps = dependencies();
  const original = deps.resolveProduct;
  deps.resolveProduct = async (lookup) => {
    const product = await original(lookup);
    product.variants[0].isAvailable = false;
    return product;
  };

  await assert.rejects(
    () => resolveCanonicalOrderSnapshot(input, deps),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'VARIANT_UNAVAILABLE',
  );
});

test('rejects a server variant whose product relationship does not match', async () => {
  const deps = dependencies();
  const original = deps.resolveProduct;
  deps.resolveProduct = async (lookup) => {
    const product = await original(lookup);
    product.variants[0].productId = 'other-product';
    return product;
  };

  await assert.rejects(
    () => resolveCanonicalOrderSnapshot(input, deps),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'VARIANT_PRODUCT_MISMATCH',
  );
});

test('rejects missing catalog proof for a provider-resolved SKU', async () => {
  await assert.rejects(
    () =>
      resolveCanonicalOrderSnapshot(
        input,
        dependencies({ resolveCatalogVariants: async () => [] }),
      ),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'MISSING_CATALOG_VARIANT',
  );
});

test('rejects catalog proof whose supplier product or variant identity conflicts', async () => {
  for (const identityOverride of [
    { supplierProductId: 'other-supplier-product' },
    { supplierVariantId: 'other-supplier-variant' },
  ]) {
    await assert.rejects(
      () =>
        resolveCanonicalOrderSnapshot(
          input,
          dependencies({
            resolveCatalogVariants: async () => [
              {
                sku: 'TRUSTED-SKU',
                supplierProductId: 'supplier-product',
                supplierVariantId: 'supplier-variant',
                catalogRow,
                ...identityOverride,
              },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof CanonicalOrderResolutionError &&
        error.code === 'CATALOG_VARIANT_IDENTITY_MISMATCH',
    );
  }
});

test('rejects unavailable live pricing', async () => {
  const deps = dependencies();
  const original = deps.resolveProduct;
  deps.resolveProduct = async (lookup) => {
    const product = await original(lookup);
    product.variants[0].unitPriceUsd = Number.NaN;
    return product;
  };

  await assert.rejects(
    () => resolveCanonicalOrderSnapshot(input, deps),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'LIVE_PRICE_UNAVAILABLE',
  );
});

test('rejects the unsafe flat shipping fallback', async () => {
  await assert.rejects(
    () =>
      resolveCanonicalOrderSnapshot(
        input,
        dependencies({
          resolveShipping: async () => ({
            source: 'FLAT_7',
            totalUsdCents: 1_200,
            allocationsUsdCents: { 'trusted-product:trusted-variant': 1_200 },
            rowFallbackSkus: [],
          }),
        }),
      ),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'UNSAFE_SHIPPING_FALLBACK',
  );
});

test('rejects oversized carts before any provider lookup', async () => {
  let productCalls = 0;
  const deps = dependencies({
    resolveProduct: async () => {
      productCalls += 1;
      throw new Error('should not run');
    },
  });
  const selections = Array.from(
    { length: CANONICAL_ORDER_RESOLUTION_LIMITS.maxSelectionCount + 1 },
    (_, index) => ({ productId: `product-${index}`, variantId: `variant-${index}`, quantity: 1 }),
  );

  await assert.rejects(
    () => resolveCanonicalOrderSnapshot({ ...input, selections }, deps),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'INVALID_ORDER_SELECTION',
  );
  assert.equal(productCalls, 0);
});

test('rejects duplicate lines whose aggregate quantity exceeds the line limit', async () => {
  await assert.rejects(
    () =>
      resolveCanonicalOrderSnapshot(
        {
          ...input,
          selections: [
            {
              productId: 'browser-product-lookup',
              variantId: 'trusted-variant',
              quantity: CANONICAL_ORDER_RESOLUTION_LIMITS.maxLineQuantity,
            },
            {
              productId: 'browser-product-lookup',
              variantId: 'trusted-variant',
              quantity: 1,
            },
          ],
        },
        dependencies(),
      ),
    (error: unknown) =>
      error instanceof CanonicalOrderResolutionError && error.code === 'INVALID_ORDER_SELECTION',
  );
});

test('bounds concurrent trusted-product resolution work', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const selections = Array.from({ length: 10 }, (_, index) => ({
    productId: `product-${index}`,
    variantId: `variant-${index}`,
    quantity: 1,
  }));
  const deps = dependencies({
    resolveProduct: async (lookup) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const index = lookup.slice('product-'.length);
      return {
        productId: lookup,
        title: `Product ${index}`,
        isAvailable: true,
        variants: [
          {
            variantId: `variant-${index}`,
            productId: lookup,
            supplierProductId: 'supplier-product',
            supplierVariantId: 'supplier-variant',
            sku: 'TRUSTED-SKU',
            sellerSku: null,
            title: `Variant ${index}`,
            selectedOptions: [],
            imageUrl: 'https://images.example/trusted.jpg',
            unitPriceUsd: 10,
            priceSource: 'live',
            isAvailable: true,
          },
        ],
      };
    },
    resolveShipping: async ({ lines }) => ({
      source: 'MERCHIZE_CATALOG',
      totalUsdCents: lines.length * 100,
      allocationsUsdCents: Object.fromEntries(lines.map((line) => [line.lineId, 100])),
      rowFallbackSkus: [],
    }),
  });

  const snapshot = await resolveCanonicalOrderSnapshot({ ...input, selections }, deps);

  assert.equal(snapshot.lines.length, 10);
  assert.equal(calls, 10);
  assert.ok(peak <= CANONICAL_ORDER_RESOLUTION_LIMITS.maxConcurrentProductResolutions);
});
