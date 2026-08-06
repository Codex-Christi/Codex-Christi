import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import type { CanonicalOrderSnapshotDraft } from '@/lib/paypal/orderSnapshot/types';
import { mapRecoveryCheckoutSummary } from './mapRecoveryCheckoutSummary';

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
        sellerSku: null,
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

function recoveryRow() {
  return {
    orderToken: 'order-token-12345678',
    status: 'captured',
    cartSnapshot: [{ title: 'Untrusted title', quantity: 999 }],
    shippingSnapshot: {
      shipping_city: 'Berlin',
      shipping_state: 'UNTRUSTED-STATE',
      shipping_country: 'UNTRUSTED-COUNTRY',
    },
    authorizePayload: { amount: { value: '25.00', currencyCode: 'EUR' } },
    capturePayload: {
      id: 'capture-1',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '0.01', currencyCode: 'USD' },
    },
    receiptLink: null,
    receiptFile: null,
    djangoPaymentSaveCustomId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: new Date('2026-08-06T12:00:00.000Z'),
    updatedAt: new Date('2026-08-06T12:05:00.000Z'),
  };
}

test('customer recovery summaries prefer valid canonical order and destination data', () => {
  const snapshot = finalizeCanonicalOrderSnapshot(canonicalDraft());
  const summary = mapRecoveryCheckoutSummary({
    ...recoveryRow(),
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  });

  assert.equal(summary.itemCount, 2);
  assert.deepEqual(summary.itemTitles, ['Trusted title']);
  assert.equal(summary.itemSummaryLabel, 'Trusted title');
  assert.equal(summary.shippingSummaryLabel, 'Berlin, BE, DEU');
  assert.equal(summary.paidAmountLabel, '$0.01');
  assert.equal(
    summary.message,
    'Your payment was received, but its amount requires review before fulfillment.',
  );
});

test('customer recovery summaries do not restore a raw state when canonical region is null', () => {
  const draft = canonicalDraft();
  draft.destination.region = null;
  const snapshot = finalizeCanonicalOrderSnapshot(draft);
  const summary = mapRecoveryCheckoutSummary({
    ...recoveryRow(),
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  });

  assert.equal(summary.shippingSummaryLabel, 'Berlin, DEU');
});

test('customer recovery summaries preserve raw-cart behavior for all-null legacy rows', () => {
  const summary = mapRecoveryCheckoutSummary({
    ...recoveryRow(),
    canonicalOrderSnapshot: null,
    canonicalOrderSnapshotVersion: null,
    canonicalOrderSnapshotHash: null,
  });

  assert.equal(summary.itemCount, 999);
  assert.deepEqual(summary.itemTitles, ['Untrusted title']);
  assert.equal(summary.shippingSummaryLabel, 'Berlin, UNTRUSTED-STATE, UNTRUSTED-COUNTRY');
  assert.equal(summary.paidAmountLabel, '$0.01');
});

test('customer recovery summaries stay inspectable but never use cart for partial canonical rows', () => {
  const summary = mapRecoveryCheckoutSummary({
    ...recoveryRow(),
    canonicalOrderSnapshot: null,
    canonicalOrderSnapshotVersion: 'shop-alpha-order-v1',
    canonicalOrderSnapshotHash: null,
  });

  assert.equal(summary.itemCount, 0);
  assert.deepEqual(summary.itemTitles, []);
  assert.equal(summary.itemSummaryLabel, null);
  assert.equal(summary.shippingSummaryLabel, null);
  assert.equal(summary.paidAmountLabel, '$0.01');
  assert.equal(
    summary.message,
    'Your payment was received, but its amount requires review before fulfillment.',
  );
});
