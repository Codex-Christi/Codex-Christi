import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePayPalMoney } from './payPalMoneyReconciliation';

test('matches equivalent decimal and currency formatting without floating-point conversion', () => {
  const result = reconcilePayPalMoney(
    { value: '00012345678901234567890.5000', currency: ' usd ' },
    { value: '12345678901234567890.5', currency: 'USD' },
  );

  assert.deepEqual(result, {
    ok: true,
    code: 'MATCH',
    expected: { value: '12345678901234567890.5', currency: 'USD' },
    actual: { value: '12345678901234567890.5', currency: 'USD' },
    reason: 'PayPal amount matches the expected 12345678901234567890.5 USD.',
  });
});

test('reports an exact value mismatch', () => {
  const result = reconcilePayPalMoney(
    { value: '57.00', currency: 'EUR' },
    { value: '56.99', currency: 'EUR' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALUE_MISMATCH');
  assert.deepEqual(result.expected, { value: '57', currency: 'EUR' });
  assert.deepEqual(result.actual, { value: '56.99', currency: 'EUR' });
});

test('reports a currency mismatch before comparing values', () => {
  const result = reconcilePayPalMoney(
    { value: '57.00', currency: 'GBP' },
    { value: '57.01', currency: 'USD' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CURRENCY_MISMATCH');
  assert.deepEqual(result.expected, { value: '57', currency: 'GBP' });
  assert.deepEqual(result.actual, { value: '57.01', currency: 'USD' });
});

test('distinguishes missing PayPal evidence from malformed PayPal evidence', () => {
  const missing = reconcilePayPalMoney({ value: '10.00', currency: 'USD' }, null);
  const malformed = reconcilePayPalMoney(
    { value: '10.00', currency: 'USD' },
    { value: '1e1', currency: 'USD' },
  );

  assert.equal(missing.code, 'ACTUAL_AMOUNT_MISSING');
  assert.equal(malformed.code, 'ACTUAL_AMOUNT_INVALID');
});

test('fails closed when the server-owned expected amount is absent or invalid', () => {
  assert.equal(
    reconcilePayPalMoney(undefined, { value: '10', currency: 'USD' }).code,
    'EXPECTED_AMOUNT_MISSING',
  );
  assert.equal(
    reconcilePayPalMoney({ value: '-10.00', currency: 'USD' }, { value: '-10.00', currency: 'USD' })
      .code,
    'EXPECTED_AMOUNT_INVALID',
  );
  assert.equal(
    reconcilePayPalMoney({ value: '10.00', currency: 'US' }, { value: '10.00', currency: 'US' })
      .code,
    'EXPECTED_AMOUNT_INVALID',
  );
});

test('supports exact zero-decimal amounts without inventing a currency restriction', () => {
  const result = reconcilePayPalMoney(
    { value: '4200', currency: 'JPY' },
    { value: '4200.0', currency: 'jpy' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.code, 'MATCH');
  assert.deepEqual(result.expected, { value: '4200', currency: 'JPY' });
});
