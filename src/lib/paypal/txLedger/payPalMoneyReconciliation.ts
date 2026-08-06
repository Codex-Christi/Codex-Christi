export type PayPalMoney = Readonly<{
  value: string;
  currency: string;
}>;

export type PayPalMoneyInput =
  | Readonly<{
      value?: unknown;
      currency?: unknown;
    }>
  | null
  | undefined;

export type PayPalMoneyReconciliationCode =
  | 'MATCH'
  | 'EXPECTED_AMOUNT_MISSING'
  | 'EXPECTED_AMOUNT_INVALID'
  | 'ACTUAL_AMOUNT_MISSING'
  | 'ACTUAL_AMOUNT_INVALID'
  | 'CURRENCY_MISMATCH'
  | 'VALUE_MISMATCH';

export type PayPalMoneyReconciliation = Readonly<{
  ok: boolean;
  code: PayPalMoneyReconciliationCode;
  expected: PayPalMoney | null;
  actual: PayPalMoney | null;
  reason: string;
}>;

type MoneySide = 'expected' | 'actual';

type NormalizationResult =
  | { ok: true; money: PayPalMoney }
  | { ok: false; code: PayPalMoneyReconciliationCode; reason: string };

function missingCode(side: MoneySide): PayPalMoneyReconciliationCode {
  return side === 'expected' ? 'EXPECTED_AMOUNT_MISSING' : 'ACTUAL_AMOUNT_MISSING';
}

function invalidCode(side: MoneySide): PayPalMoneyReconciliationCode {
  return side === 'expected' ? 'EXPECTED_AMOUNT_INVALID' : 'ACTUAL_AMOUNT_INVALID';
}

function normalizeDecimal(value: unknown) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;

  const [integerPart, fractionPart = ''] = trimmed.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');

  return fraction ? `${integer}.${fraction}` : integer;
}

function normalizeCurrency(currency: unknown) {
  if (typeof currency !== 'string') return null;

  const normalized = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function normalizeMoney(input: PayPalMoneyInput, side: MoneySide): NormalizationResult {
  if (!input) {
    return {
      ok: false,
      code: missingCode(side),
      reason: `${side === 'expected' ? 'Expected' : 'Actual'} PayPal amount is missing.`,
    };
  }

  const value = normalizeDecimal(input.value);
  const currency = normalizeCurrency(input.currency);

  if (!value || !currency) {
    return {
      ok: false,
      code: invalidCode(side),
      reason: `${side === 'expected' ? 'Expected' : 'Actual'} PayPal amount is invalid.`,
    };
  }

  return { ok: true, money: { value, currency } };
}

/**
 * Compares the server-owned order total with PayPal evidence without converting
 * either decimal string to a JavaScript number. Formatting-only differences,
 * such as `10.00` versus `10.0`, do not produce a false mismatch.
 */
export function reconcilePayPalMoney(
  expectedInput: PayPalMoneyInput,
  actualInput: PayPalMoneyInput,
): PayPalMoneyReconciliation {
  const expected = normalizeMoney(expectedInput, 'expected');
  if (!expected.ok) {
    return {
      ok: false,
      code: expected.code,
      expected: null,
      actual: null,
      reason: expected.reason,
    };
  }

  const actual = normalizeMoney(actualInput, 'actual');
  if (!actual.ok) {
    return {
      ok: false,
      code: actual.code,
      expected: expected.money,
      actual: null,
      reason: actual.reason,
    };
  }

  if (expected.money.currency !== actual.money.currency) {
    return {
      ok: false,
      code: 'CURRENCY_MISMATCH',
      expected: expected.money,
      actual: actual.money,
      reason: `PayPal currency ${actual.money.currency} does not match expected currency ${expected.money.currency}.`,
    };
  }

  if (expected.money.value !== actual.money.value) {
    return {
      ok: false,
      code: 'VALUE_MISMATCH',
      expected: expected.money,
      actual: actual.money,
      reason: `PayPal amount ${actual.money.value} ${actual.money.currency} does not match expected amount ${expected.money.value} ${expected.money.currency}.`,
    };
  }

  return {
    ok: true,
    code: 'MATCH',
    expected: expected.money,
    actual: actual.money,
    reason: `PayPal amount matches the expected ${expected.money.value} ${expected.money.currency}.`,
  };
}
