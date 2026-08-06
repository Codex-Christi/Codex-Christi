import assert from 'node:assert/strict';
import test from 'node:test';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import {
  CART_AVAILABILITY_INPUT_LIMITS,
  mapCartAvailabilityProducts,
  parseCartAvailabilityInput,
} from './cartAvailabilityInput';

function cartItem(variantId: string, overrides: Partial<CartVariant> = {}): CartVariant {
  return {
    variantId,
    quantity: 1,
    title: 'Product',
    slug: 'product',
    itemDetail: {
      _id: variantId,
      product: 'product-1',
      image_uris: [],
      retail_price: 10,
      is_default: false,
      title: 'Variant',
      options: [],
    },
    ...overrides,
  };
}

test('normalizes bounded cart availability selectors', () => {
  const rows = parseCartAvailabilityInput([
    cartItem(' variant-1 ', {
      itemDetail: { ...cartItem('variant-1').itemDetail, _id: 'variant-1' },
    }),
  ]);

  assert.deepEqual(
    rows.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })),
    [{ productId: 'product-1', variantId: 'variant-1', quantity: 1 }],
  );
});

test('rejects too many rows, excessive line quantities, and excessive total quantity', () => {
  assert.throws(
    () =>
      parseCartAvailabilityInput(
        Array.from({ length: CART_AVAILABILITY_INPUT_LIMITS.maxRows + 1 }, (_, index) =>
          cartItem(`variant-${index}`),
        ),
      ),
    /row limit/,
  );
  assert.throws(
    () =>
      parseCartAvailabilityInput([
        cartItem('variant-1', {
          quantity: CART_AVAILABILITY_INPUT_LIMITS.maxLineQuantity + 1,
        }),
      ]),
    /invalid quantity/,
  );
  assert.throws(
    () =>
      parseCartAvailabilityInput(
        Array.from({ length: 5 }, (_, index) =>
          cartItem(`variant-${index}`, {
            quantity: CART_AVAILABILITY_INPUT_LIMITS.maxLineQuantity,
          }),
        ),
      ),
    /quantity limit/,
  );
});

test('rejects oversized, duplicate, and conflicting cart identities', () => {
  assert.throws(
    () =>
      parseCartAvailabilityInput([
        cartItem('x'.repeat(CART_AVAILABILITY_INPUT_LIMITS.maxIdentifierLength + 1)),
      ]),
    /variant identity/,
  );
  assert.throws(
    () => parseCartAvailabilityInput([cartItem('variant-1'), cartItem('variant-1')]),
    /duplicated/,
  );
  assert.throws(
    () =>
      parseCartAvailabilityInput([
        cartItem('variant-1'),
        cartItem('variant-1', {
          itemDetail: { ...cartItem('variant-1').itemDetail, product: 'product-2' },
        }),
      ]),
    /conflicting product identities/,
  );
  assert.throws(
    () =>
      parseCartAvailabilityInput([
        cartItem('variant-1', {
          itemDetail: { ...cartItem('variant-1').itemDetail, _id: 'variant-2' },
        }),
      ]),
    /conflicting identity data/,
  );
});

test('bounds concurrent live cart product resolutions', async () => {
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 12 }, (_, index) => index);

  const results = await mapCartAvailabilityProducts(values, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, values.map((value) => value * 2));
  assert.ok(peak <= CART_AVAILABILITY_INPUT_LIMITS.maxConcurrentProductResolutions);
});
