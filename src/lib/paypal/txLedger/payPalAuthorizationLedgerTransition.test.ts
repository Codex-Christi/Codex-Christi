import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
} from '@/lib/paypal/orderSnapshot/types';
import { getPayPalAuthorizationMoney } from './canonicalPaymentReconciliation';
import { commitOptimisticLedgerTransition } from './optimisticLedgerTransition';
import {
  buildPayPalAuthorizationFailureLedgerTransition,
  buildPayPalAuthorizationLedgerTransition,
  type PayPalAuthorizationTransitionRow,
} from './payPalAuthorizationLedgerTransition';
import { PAYPAL_LEDGER_STATUS } from './status';

function canonicalRow(): PayPalAuthorizationTransitionRow {
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
    status: PAYPAL_LEDGER_STATUS.INTENT_CREATED,
    paypalAuthorizationId: null,
    authorizePayload: null,
    canonicalOrderSnapshot: snapshot,
    canonicalOrderSnapshotVersion: snapshot.version,
    canonicalOrderSnapshotHash: snapshot.hash,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

test('a CAS retry preserves a concurrently committed authorization mismatch', async () => {
  const initial = canonicalRow();
  const mismatch = {
    ...initial,
    status: PAYPAL_LEDGER_STATUS.ERROR,
    paypalAuthorizationId: 'authorization-id',
    authorizePayload: {
      id: 'authorization-id',
      amount: { value: '24.99', currencyCode: 'USD' },
    },
    lastErrorCode: 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
    lastErrorMessage: 'A signed authorization event did not match the canonical total.',
  };
  const matchingOrderResponse = {
    purchaseUnits: [
      {
        payments: {
          authorizations: [
            {
              id: 'authorization-id',
              amount: { value: '25.00', currencyCode: 'USD' },
            },
          ],
        },
      },
    ],
  };
  let loadCount = 0;
  const committed = await commitOptimisticLedgerTransition({
    load: async () => (loadCount++ === 0 ? initial : mismatch),
    build: (row) => buildPayPalAuthorizationLedgerTransition(row, matchingOrderResponse),
    commit: async (_row, transition) =>
      transition.data.status === PAYPAL_LEDGER_STATUS.ERROR,
  });

  assert.equal(committed.attempts, 2);
  assert.equal(committed.transition.data.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(
    committed.transition.reconciliationFailure?.errorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.deepEqual(
    getPayPalAuthorizationMoney(committed.transition.data.authorizePayload),
    { value: '24.99', currency: 'USD' },
  );
});

test('a stale route failure cannot erase mismatched evidence before a matching resync', () => {
  const initial = canonicalRow();
  const mismatchedAuthorization = {
    id: 'authorization-id',
    amount: { value: '24.99', currencyCode: 'USD' },
  };
  const mismatch = buildPayPalAuthorizationLedgerTransition(
    initial,
    mismatchedAuthorization,
  );
  const afterMismatch = {
    ...initial,
    ...mismatch.data,
  } as PayPalAuthorizationTransitionRow;
  const staleFailure = buildPayPalAuthorizationFailureLedgerTransition(afterMismatch, {
    code: 'AUTHORIZE_FAILED',
    message: 'A stale authorize request failed after the webhook committed.',
  });
  const afterFailure = {
    ...afterMismatch,
    ...staleFailure.data,
    // Prove the invariant comes from durable evidence, even if an older/stale writer has already
    // replaced the diagnostic label before this code is deployed or retried.
    lastErrorCode: 'AUTHORIZE_FAILED',
    lastErrorMessage: 'A stale authorize request failed after the webhook committed.',
  } as PayPalAuthorizationTransitionRow;
  const matchingResync = buildPayPalAuthorizationLedgerTransition(afterFailure, {
    purchaseUnits: [
      {
        payments: {
          authorizations: [
            {
              id: 'authorization-id',
              amount: { value: '25.00', currencyCode: 'USD' },
            },
          ],
        },
      },
    ],
  });

  assert.equal(staleFailure.data.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(
    staleFailure.data.lastErrorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.equal(matchingResync.data.status, PAYPAL_LEDGER_STATUS.ERROR);
  assert.equal(
    matchingResync.reconciliationFailure?.errorCode,
    'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  );
  assert.deepEqual(
    getPayPalAuthorizationMoney(matchingResync.data.authorizePayload),
    { value: '24.99', currency: 'USD' },
  );
});
