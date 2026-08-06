import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogItem } from '@/lib/datasetSearchers/merchize/catalog';
import { calculateStrictShippingQuoteUsd, StrictShippingResolutionError } from './strictShipping';

function row(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    SKU_product: 'PRODUCT',
    SKU_variant: 'SKU-1',
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
    ...overrides,
  };
}

test('uses catalog shipping and preserves the existing per-unit minimum', () => {
  const quote = calculateStrictShippingQuoteUsd({
    lines: [{ lineId: 'line-1', sku: 'SKU-1', quantity: 2 }],
    catalogRows: [row()],
    countryIso3: 'USA',
  });

  assert.equal(quote.source, 'MERCHIZE_CATALOG');
  assert.equal(quote.totalUsdCents, 1_000);
  assert.deepEqual(quote.allocationsUsdCents, { 'line-1': 1_000 });
  assert.deepEqual(quote.rowFallbackSkus, []);
});

test('preserves checkout ROW-band behavior without inventing a flat rate', () => {
  const quote = calculateStrictShippingQuoteUsd({
    lines: [{ lineId: 'line-1', sku: 'SKU-1', quantity: 1 }],
    catalogRows: [row()],
    countryIso3: 'CAN',
  });

  assert.equal(quote.totalUsdCents, 1_100);
  // CAN maps directly to the existing ROW destination, so this is not a secondary fallback.
  assert.deepEqual(quote.rowFallbackSkus, []);
});

test('uses the existing ROW fallback when a mapped destination band is absent', () => {
  const quote = calculateStrictShippingQuoteUsd({
    lines: [{ lineId: 'line-1', sku: 'SKU-1', quantity: 1 }],
    catalogRows: [row({ GB_shipping_fee: null, GB_additional_shipping_fee: null })],
    countryIso3: 'GBR',
  });

  assert.equal(quote.totalUsdCents, 1_100);
  assert.deepEqual(quote.rowFallbackSkus, ['SKU-1']);
});

test('rejects missing SKU rows instead of using the historical $7/$5 fallback', () => {
  assert.throws(
    () =>
      calculateStrictShippingQuoteUsd({
        lines: [{ lineId: 'line-1', sku: 'MISSING', quantity: 1 }],
        catalogRows: [],
        countryIso3: 'USA',
      }),
    (error: unknown) =>
      error instanceof StrictShippingResolutionError &&
      error.code === 'MISSING_SHIPPING_CATALOG_ROW',
  );
});

test('rejects a missing destination and ROW band instead of fabricating shipping', () => {
  assert.throws(
    () =>
      calculateStrictShippingQuoteUsd({
        lines: [{ lineId: 'line-1', sku: 'SKU-1', quantity: 1 }],
        catalogRows: [
          row({
            EU_shipping_fee: null,
            EU_additional_shipping_fee: null,
            ROW_shipping_fee: null,
            ROW_additional_shipping_fee: null,
          }),
        ],
        countryIso3: 'FRA',
      }),
    (error: unknown) =>
      error instanceof StrictShippingResolutionError && error.code === 'INVALID_SHIPPING_BAND',
  );
});
