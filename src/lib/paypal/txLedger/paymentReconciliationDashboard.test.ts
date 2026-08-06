import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';
import type { PaymentLedgerRow } from './paymentReconciliationTypes';
import { isPaymentReconciliationCandidate } from './paymentReconciliationDashboard';

function completedCapture(value: string) {
  return {
    id: 'capture-1',
    status: 'COMPLETED',
    finalCapture: true,
    amount: { value, currencyCode: 'EUR' },
  };
}

function canonicalRow(): PaymentLedgerRow {
  const snapshot = finalizeCanonicalOrderSnapshot({
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: { countryIso3: 'USA', region: 'CA' },
    currency: 'EUR',
    lines: [
      {
        lineId: 'product-1:variant-1',
        productId: 'product-1',
        variantId: 'variant-1',
        supplierProductId: 'supplier-product-1',
        supplierVariantId: 'supplier-variant-1',
        sku: 'MERCHIZE-SKU-1',
        sellerSku: null,
        title: 'Canonical product',
        selectedOptions: [],
        imageUrl: 'https://example.test/image.png',
        quantity: 1,
        unitAmount: { currency: 'EUR', value: '57.00' },
        lineAmount: { currency: 'EUR', value: '57.00' },
        shippingAllocation: { currency: 'EUR', value: '0.00' },
      },
    ],
    subtotal: { currency: 'EUR', value: '57.00' },
    shipping: { currency: 'EUR', value: '0.00' },
    total: { currency: 'EUR', value: '57.00' },
  });

  return {
    orderToken: 'order-token-1',
    paypalOrderId: 'paypal-order-1',
    paypalAuthorizationId: null,
    customerName: 'Customer',
    customerEmail: 'customer@example.test',
    initialCurrency: 'EUR',
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
    authorizePayload: { amount: { value: '57.00', currencyCode: 'EUR' } },
    capturePayload: completedCapture('56.99'),
    status: 'captured',
    lastErrorCode: null,
    lastErrorMessage: null,
    processingCompletedAt: null,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    updatedAt: new Date('2026-08-06T00:01:00.000Z'),
  };
}

test('completed capture with canonical mismatch is a candidate before ERROR is persisted', () => {
  const row = canonicalRow();

  assert.equal(row.paypalAuthorizationId, null);
  assert.equal(row.lastErrorCode, null);
  assert.equal(isPaymentReconciliationCandidate(row), true);
});

test('completed capture with matching canonical amount is not a reconciliation candidate', () => {
  const row = canonicalRow();
  row.capturePayload = completedCapture('57.00');

  assert.equal(isPaymentReconciliationCandidate(row), false);
});

test('completed matching capture remains a candidate when authorization money mismatches', () => {
  const row = canonicalRow();
  row.capturePayload = completedCapture('57.00');
  row.authorizePayload = { amount: { value: '56.99', currencyCode: 'EUR' } };

  assert.equal(isPaymentReconciliationCandidate(row), true);
});
