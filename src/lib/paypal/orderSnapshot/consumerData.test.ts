import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCanonicalFulfillmentItems,
  getCanonicalInvoicePricing,
  getCanonicalPaymentAmountReceived,
} from './consumerData';
import type { CanonicalOrderSnapshot } from './types';

function snapshot(currency = 'EUR', unit = '12.34'): CanonicalOrderSnapshot {
  const lineAmount = currency === 'JPY' ? String(Number(unit) * 2) : '24.68';
  const shipping = currency === 'JPY' ? '500' : '5.00';
  const total = currency === 'JPY' ? String(Number(lineAmount) + Number(shipping)) : '29.68';

  return {
    version: 'shop-alpha-order-v1',
    hashAlgorithm: 'sha256',
    hash: 'a'.repeat(64),
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: { countryIso3: 'DEU', region: null },
    currency,
    lines: [
      {
        lineId: 'seller-product:seller-variant',
        productId: 'seller-product',
        variantId: 'seller-variant',
        supplierProductId: 'catalog-product',
        supplierVariantId: 'catalog-variant',
        sku: 'MERCHIZE-SKU',
        sellerSku: 'SELLER-SKU',
        title: 'Trusted shirt',
        selectedOptions: [{ name: 'Size', value: 'M' }],
        imageUrl: 'https://example.test/trusted.jpg',
        quantity: 2,
        unitAmount: { value: unit, currency },
        lineAmount: { value: lineAmount, currency },
        shippingAllocation: { value: shipping, currency },
      },
    ],
    subtotal: { value: lineAmount, currency },
    shipping: { value: shipping, currency },
    total: { value: total, currency },
  };
}

test('receipt and Django projections preserve the canonical strings exactly', () => {
  const input = snapshot();

  assert.deepEqual(getCanonicalInvoicePricing(input), {
    currencyCode: 'EUR',
    items: [
      {
        name: 'Trusted shirt',
        sku: 'SELLER-SKU',
        quantity: '2',
        unitAmount: { value: '12.34', currencyCode: 'EUR' },
        lineAmount: '24.68',
      },
    ],
    subtotal: '24.68',
    shipping: '5.00',
    total: '29.68',
  });
  assert.equal(getCanonicalPaymentAmountReceived(input), '29.68 EUR');
});

test('zero-decimal receipt values stay zero-decimal', () => {
  const pricing = getCanonicalInvoicePricing(snapshot('JPY', '1200'));

  assert.equal(pricing.items[0].unitAmount.value, '1200');
  assert.equal(pricing.items[0].lineAmount, '2400');
  assert.equal(pricing.shipping, '500');
  assert.equal(pricing.total, '2900');
});

test('fulfillment uses only canonical seller identity and catalog-proven production fields', () => {
  assert.deepEqual(getCanonicalFulfillmentItems(snapshot()), [
    {
      product_id: 'seller-product',
      sku: 'SELLER-SKU',
      merchize_sku: 'MERCHIZE-SKU',
      quantity: 2,
      price: 12.34,
      currency: 'EUR',
      image: 'https://example.test/trusted.jpg',
    },
  ]);
});

test('fulfillment rejects a canonical value that cannot cross the numeric wire safely', () => {
  const input = snapshot();
  input.lines[0].unitAmount.value = '9'.repeat(400);

  assert.throws(() => getCanonicalFulfillmentItems(input), /unsafe for fulfillment/);
});
