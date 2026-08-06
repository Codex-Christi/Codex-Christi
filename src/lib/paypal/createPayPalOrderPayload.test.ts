import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';
import {
  buildPayPalOrderCreatePayload,
  type BuildPayPalOrderCreatePayloadInput,
} from './createPayPalOrderPayload';

function euroSnapshot(): CanonicalOrderSnapshot {
  return {
    version: 'shop-alpha-order-v1',
    hashAlgorithm: 'sha256',
    hash: 'a'.repeat(64),
    createdAt: '2026-08-06T12:30:00.000Z',
    destination: { countryIso3: 'DEU', region: 'BE' },
    currency: 'EUR',
    lines: [
      {
        lineId: 'product-a:variant-a',
        productId: 'product-a',
        variantId: 'variant-a',
        supplierProductId: 'supplier-product-a',
        supplierVariantId: 'supplier-variant-a',
        sku: 'SUPPLIER-SKU-A',
        sellerSku: 'SELLER-SKU-A',
        title: 'Alpha Shirt',
        selectedOptions: [{ name: 'Size', value: 'Large' }],
        imageUrl: 'https://example.com/alpha-shirt.jpg',
        quantity: 2,
        unitAmount: { currency: 'EUR', value: '15.25' },
        lineAmount: { currency: 'EUR', value: '30.50' },
        shippingAllocation: { currency: 'EUR', value: '4.25' },
      },
      {
        lineId: 'product-b:variant-b',
        productId: 'product-b',
        variantId: 'variant-b',
        supplierProductId: 'supplier-product-b',
        supplierVariantId: 'supplier-variant-b',
        sku: 'SUPPLIER-SKU-B',
        sellerSku: null,
        title: 'Beta Tote',
        selectedOptions: [],
        imageUrl: 'https://example.com/beta-tote.jpg',
        quantity: 1,
        unitAmount: { currency: 'EUR', value: '15.00' },
        lineAmount: { currency: 'EUR', value: '15.00' },
        shippingAllocation: { currency: 'EUR', value: '3.00' },
      },
    ],
    subtotal: { currency: 'EUR', value: '45.50' },
    shipping: { currency: 'EUR', value: '7.25' },
    total: { currency: 'EUR', value: '52.75' },
  };
}

function buildInput(
  canonicalOrderSnapshot: CanonicalOrderSnapshot = euroSnapshot(),
): BuildPayPalOrderCreatePayloadInput {
  return {
    orderToken: 'order-token-123',
    canonicalOrderSnapshot,
    customer: { name: 'Test Customer', email: 'customer@example.com' },
    country: 'DE',
    delivery_address: {
      shipping_address_line_1: 'Teststrasse 1',
      shipping_address_line_2: 'Apartment 2',
      shipping_city: 'Berlin',
      shipping_state: 'BE',
      shipping_country: 'DEU',
      zip_code: '10115',
    },
  };
}

test('builds multi-currency PayPal items and exact totals only from the canonical snapshot', () => {
  const payload = buildPayPalOrderCreatePayload(buildInput());
  const purchaseUnit = payload.body.purchaseUnits[0];

  assert.deepEqual(purchaseUnit.amount, {
    currencyCode: 'EUR',
    value: '52.75',
    breakdown: {
      itemTotal: { currencyCode: 'EUR', value: '45.50' },
      shipping: { currencyCode: 'EUR', value: '7.25' },
    },
  });
  assert.deepEqual(
    purchaseUnit.items?.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      sku: item.sku,
    })),
    [
      {
        name: 'Alpha Shirt',
        quantity: '2',
        unitAmount: { currencyCode: 'EUR', value: '15.25' },
        sku: 'SELLER-SKU-A',
      },
      {
        name: 'Beta Tote',
        quantity: '1',
        unitAmount: { currencyCode: 'EUR', value: '15.00' },
        sku: 'SUPPLIER-SKU-B',
      },
    ],
  );
});

test('passes zero-decimal snapshot amounts to PayPal without adding decimal precision', () => {
  const snapshot = euroSnapshot();
  snapshot.currency = 'JPY';
  snapshot.lines = [
    {
      ...snapshot.lines[0],
      quantity: 1,
      unitAmount: { currency: 'JPY', value: '4200' },
      lineAmount: { currency: 'JPY', value: '4200' },
      shippingAllocation: { currency: 'JPY', value: '500' },
    },
  ];
  snapshot.subtotal = { currency: 'JPY', value: '4200' };
  snapshot.shipping = { currency: 'JPY', value: '500' };
  snapshot.total = { currency: 'JPY', value: '4700' };

  const purchaseUnit = buildPayPalOrderCreatePayload(buildInput(snapshot)).body.purchaseUnits[0];

  assert.equal(purchaseUnit.amount.value, '4700');
  assert.equal(purchaseUnit.amount.currencyCode, 'JPY');
  assert.equal(purchaseUnit.amount.breakdown?.itemTotal?.value, '4200');
  assert.equal(purchaseUnit.amount.breakdown?.shipping?.value, '500');
  assert.equal(purchaseUnit.items?.[0]?.unitAmount.value, '4200');
});

test('emits no item tax or PayPal tax-total field', () => {
  const purchaseUnit = buildPayPalOrderCreatePayload(buildInput()).body.purchaseUnits[0];

  assert.equal('taxTotal' in (purchaseUnit.amount.breakdown ?? {}), false);
  assert.equal(
    purchaseUnit.items?.some((item) => 'tax' in item),
    false,
  );
  assert.equal(JSON.stringify(purchaseUnit).toLowerCase().includes('tax'), false);
});

test('cannot override snapshot money with obsolete browser-cart or request-level money fields', () => {
  const input = {
    ...buildInput(),
    initialCurrency: 'USD',
    total: { value: '0.01', currency: 'USD' },
    cart: [
      {
        title: 'Tampered title',
        quantity: 999,
        itemDetail: { retail_price: 0.01, sku: 'TAMPERED-SKU' },
      },
    ],
  } as BuildPayPalOrderCreatePayloadInput & Record<string, unknown>;

  const purchaseUnit = buildPayPalOrderCreatePayload(input).body.purchaseUnits[0];

  assert.equal(purchaseUnit.amount.currencyCode, 'EUR');
  assert.equal(purchaseUnit.amount.value, '52.75');
  assert.equal(purchaseUnit.items?.[0]?.name, 'Alpha Shirt');
  assert.equal(purchaseUnit.items?.[0]?.sku, 'SELLER-SKU-A');
  assert.equal(purchaseUnit.items?.[0]?.unitAmount.value, '15.25');
});

test('preserves the provided PayPal shipping address and local order token', () => {
  const purchaseUnit = buildPayPalOrderCreatePayload(buildInput()).body.purchaseUnits[0];

  assert.equal(purchaseUnit.customId, 'order-token-123');
  assert.deepEqual(purchaseUnit.shipping, {
    name: { fullName: 'Test Customer' },
    address: {
      addressLine1: 'Teststrasse 1',
      addressLine2: 'Apartment 2',
      adminArea1: 'BE',
      adminArea2: 'Berlin',
      postalCode: '10115',
      countryCode: 'DE',
    },
    emailAddress: 'customer@example.com',
  });
});
