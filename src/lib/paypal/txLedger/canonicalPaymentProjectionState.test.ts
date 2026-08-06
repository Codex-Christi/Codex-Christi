import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';
import { getCanonicalPaymentProjectionState } from './canonicalPaymentProjectionState';
import { PAYPAL_LEDGER_STATUS } from './status';

function canonicalEnvelope() {
  const snapshot = finalizeCanonicalOrderSnapshot({
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: '2026-08-06T00:00:00.000Z',
    destination: { countryIso3: 'USA', region: 'CA' },
    currency: 'USD',
    lines: [
      {
        lineId: 'product:variant',
        productId: 'product',
        variantId: 'variant',
        supplierProductId: 'supplier-product',
        supplierVariantId: 'supplier-variant',
        sku: 'SKU',
        sellerSku: null,
        title: 'Product',
        selectedOptions: [],
        imageUrl: 'https://example.test/product.jpg',
        quantity: 1,
        unitAmount: { currency: 'USD', value: '20.00' },
        lineAmount: { currency: 'USD', value: '20.00' },
        shippingAllocation: { currency: 'USD', value: '5.00' },
      },
    ],
    subtotal: { currency: 'USD', value: '20.00' },
    shipping: { currency: 'USD', value: '5.00' },
    total: { currency: 'USD', value: '25.00' },
  });

  return {
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
  };
}

for (const status of [PAYPAL_LEDGER_STATUS.INTENT_CREATING, PAYPAL_LEDGER_STATUS.INTENT_CREATED]) {
  test(`${status} is not a false payment mismatch before PayPal evidence exists`, () => {
    const state = getCanonicalPaymentProjectionState({
      ...canonicalEnvelope(),
      status,
      authorizePayload: null,
      capturePayload: null,
    });

    assert.equal(state.requiresPaymentChain, false);
    assert.equal(state.paymentFailure, null);
    assert.equal(state.paymentSafeForPostProcessing, false);
    assert.equal(state.isPaid, false);
  });
}

test('a completed capture with mismatched canonical money is a projection failure', () => {
  const state = getCanonicalPaymentProjectionState({
    ...canonicalEnvelope(),
    status: PAYPAL_LEDGER_STATUS.ERROR,
    authorizePayload: { amount: { value: '25.00', currencyCode: 'USD' } },
    capturePayload: {
      id: 'capture-1',
      status: 'COMPLETED',
      finalCapture: true,
      amount: { value: '0.01', currencyCode: 'USD' },
    },
  });

  assert.equal(state.requiresPaymentChain, true);
  assert.equal(state.paymentSafeForPostProcessing, false);
  assert.equal(state.paymentFailure?.errorCode, 'PAYPAL_CAPTURE_AMOUNT_MISMATCH');
  assert.equal(state.isPaid, true);
});
