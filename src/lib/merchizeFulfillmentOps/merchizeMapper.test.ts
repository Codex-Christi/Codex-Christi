import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import type { CanonicalOrderSnapshotDraft } from '@/lib/paypal/orderSnapshot/types';
import { buildRegistrationSummaries } from './merchizeMapper';

function canonicalDraft(): CanonicalOrderSnapshotDraft {
  return {
    version: 'shop-alpha-order-v1',
    hashAlgorithm: 'sha256',
    createdAt: '2026-08-06T12:00:00.000Z',
    destination: { countryIso3: 'DEU', region: 'BE' },
    currency: 'EUR',
    lines: [
      {
        lineId: 'product:variant',
        productId: 'product',
        variantId: 'variant',
        supplierProductId: 'supplier-product',
        supplierVariantId: 'supplier-variant',
        sku: 'MERCHIZE-SKU',
        sellerSku: 'SELLER-SKU',
        title: 'Trusted title',
        selectedOptions: [{ name: 'Size', value: 'M' }],
        imageUrl: 'https://example.test/item.jpg',
        quantity: 2,
        unitAmount: { currency: 'EUR', value: '10.00' },
        lineAmount: { currency: 'EUR', value: '20.00' },
        shippingAllocation: { currency: 'EUR', value: '5.00' },
      },
    ],
    subtotal: { currency: 'EUR', value: '20.00' },
    shipping: { currency: 'EUR', value: '5.00' },
    total: { currency: 'EUR', value: '25.00' },
  };
}

const rawSnapshots = {
  customerEmail: 'customer@example.test',
  shippingSnapshot: {
    shipping_city: 'Berlin',
    shipping_state: 'UNTRUSTED-STATE',
    shipping_country: 'UNTRUSTED-COUNTRY',
  },
  cartSnapshot: [
    {
      quantity: 999,
      itemDetail: { currency: 'USD' },
    },
  ],
};

test('registration summaries prefer a valid canonical snapshot over raw cart metadata', () => {
  const snapshot = finalizeCanonicalOrderSnapshot(canonicalDraft());
  const summary = buildRegistrationSummaries({
    ...rawSnapshots,
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  });

  assert.equal(summary.shippingCity, 'Berlin');
  assert.equal(summary.shippingState, 'BE');
  assert.equal(summary.shippingCountry, 'DEU');
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.orderCurrency, 'EUR');
});

test('registration summaries do not restore a raw state when canonical region is null', () => {
  const draft = canonicalDraft();
  draft.destination.region = null;
  const snapshot = finalizeCanonicalOrderSnapshot(draft);
  const summary = buildRegistrationSummaries({
    ...rawSnapshots,
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  });

  assert.equal(summary.shippingState, null);
  assert.equal(summary.shippingCountry, 'DEU');
});

test('registration summaries preserve raw-cart behavior only for an all-null legacy envelope', () => {
  const summary = buildRegistrationSummaries({
    ...rawSnapshots,
    canonicalOrderSnapshot: null,
    canonicalOrderSnapshotVersion: null,
    canonicalOrderSnapshotHash: null,
  });

  assert.equal(summary.shippingState, 'UNTRUSTED-STATE');
  assert.equal(summary.shippingCountry, 'UNTRUSTED-COUNTRY');
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.totalQuantity, 999);
  assert.equal(summary.orderCurrency, 'USD');
});

test('registration summaries fail closed instead of using cart when canonical metadata is partial', () => {
  assert.throws(() =>
    buildRegistrationSummaries({
      ...rawSnapshots,
      canonicalOrderSnapshot: null,
      canonicalOrderSnapshotVersion: 'shop-alpha-order-v1',
      canonicalOrderSnapshotHash: null,
    }),
  );
});
