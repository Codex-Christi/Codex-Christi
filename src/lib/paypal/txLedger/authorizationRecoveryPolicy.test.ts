import assert from 'node:assert/strict';
import test from 'node:test';
import { PAYPAL_LEDGER_STATUS } from './status';
import { shouldResyncExistingAuthorization } from './authorizationRecoveryPolicy';

test('resyncs an authorization-webhook race with no durable order payload', () => {
  assert.equal(
    shouldResyncExistingAuthorization({
      status: PAYPAL_LEDGER_STATUS.AUTHORIZED,
      authorizePayload: null,
    }),
    true,
  );
});

test('retains existing error-state resynchronization', () => {
  assert.equal(
    shouldResyncExistingAuthorization({
      status: PAYPAL_LEDGER_STATUS.ERROR,
      authorizePayload: null,
    }),
    true,
  );
});

test('resyncs an authorized row that contains only a direct webhook resource', () => {
  assert.equal(
    shouldResyncExistingAuthorization({
      status: PAYPAL_LEDGER_STATUS.AUTHORIZED,
      authorizePayload: {
        id: 'authorization-id',
        amount: { value: '25.00', currencyCode: 'USD' },
      },
    }),
    true,
  );
});

test('does not resync a complete authorized row or a fresh intent', () => {
  assert.equal(
    shouldResyncExistingAuthorization({
      status: PAYPAL_LEDGER_STATUS.AUTHORIZED,
      authorizePayload: { purchaseUnits: [{ customId: 'order-token' }] },
    }),
    false,
  );
  assert.equal(
    shouldResyncExistingAuthorization({
      status: PAYPAL_LEDGER_STATUS.INTENT_CREATED,
      authorizePayload: null,
    }),
    false,
  );
});
