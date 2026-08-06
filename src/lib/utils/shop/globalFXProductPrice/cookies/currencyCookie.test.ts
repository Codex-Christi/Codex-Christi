import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCurrencyCookie, serializeCurrencyCookie } from './currencyCookie';

test('currency cookie serialization is shared by browser and server readers', () => {
  const value = {
    v: 1 as const,
    iso3: 'DEU',
    fx: {
      multiplier: 0.92,
      currency: 'EUR',
      currency_symbol: '€',
      ts: 1_700_000_000_000,
    },
    updatedAt: 1_700_000_000_001,
  };

  assert.deepEqual(parseCurrencyCookie(serializeCurrencyCookie(value)), value);
});

test('currency cookie parser normalizes country and rejects malformed state', () => {
  assert.deepEqual(parseCurrencyCookie('{"v":1,"iso3":" deu ","updatedAt":1}'), {
    v: 1,
    iso3: 'DEU',
    fx: undefined,
    updatedAt: 1,
  });
  assert.equal(parseCurrencyCookie('U2FsdGVkX1-not-json'), null);
  assert.equal(parseCurrencyCookie('{"v":1,"iso3":"US","updatedAt":1}'), null);
  assert.equal(parseCurrencyCookie('{"v":1,"iso3":"USA","updatedAt":"now"}'), null);
});
