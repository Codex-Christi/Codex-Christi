import assert from 'node:assert/strict';
import test from 'node:test';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import {
  createCartAvailabilityMap,
  getCartVerificationIdentity,
  getCartItemAvailability,
  hasCheckoutBlockingCartItems,
} from './cartAvailability';

function cartItem(variantId: string): CartVariant {
  return {
    variantId,
    quantity: 1,
    title: `Item ${variantId}`,
    slug: `item-${variantId}`,
    itemDetail: {
      _id: variantId,
      image_uris: [],
      retail_price: 20,
      is_default: false,
      title: `Variant ${variantId}`,
      options: [],
    },
  };
}

test('blocks checkout while any persisted cart row is not verified as available', () => {
  const cart = [cartItem('available'), cartItem('stale')];
  const availability = createCartAvailabilityMap(cart, 'available');

  assert.equal(hasCheckoutBlockingCartItems(cart, availability), false);

  availability.stale = { status: 'unavailable' };
  assert.equal(hasCheckoutBlockingCartItems(cart, availability), true);

  availability.stale = { status: 'unverified' };
  assert.equal(hasCheckoutBlockingCartItems(cart, availability), true);
});

test('fails closed when a cart row has no availability result yet', () => {
  const cart = [cartItem('pending')];

  assert.deepEqual(getCartItemAvailability({}, 'pending'), { status: 'checking' });
  assert.equal(hasCheckoutBlockingCartItems(cart, {}), true);
});

test('creates an entry for every persisted row without changing the cart data', () => {
  const cart = [cartItem('one'), cartItem('two')];
  const before = structuredClone(cart);

  assert.deepEqual(createCartAvailabilityMap(cart, 'unverified'), {
    one: { status: 'unverified' },
    two: { status: 'unverified' },
  });
  assert.deepEqual(cart, before);
});

test('changes verification identity when quantity or exact variant evidence changes', () => {
  const original = cartItem('one');
  const originalIdentity = getCartVerificationIdentity([original]);

  assert.notEqual(getCartVerificationIdentity([{ ...original, quantity: 2 }]), originalIdentity);
  assert.notEqual(
    getCartVerificationIdentity([
      {
        ...original,
        itemDetail: { ...original.itemDetail, sku: 'changed-sku' },
      },
    ]),
    originalIdentity,
  );
  assert.notEqual(
    getCartVerificationIdentity([
      {
        ...original,
        itemDetail: { ...original.itemDetail, sku_seller: 'storefront-sku' },
      },
    ]),
    originalIdentity,
  );
  assert.notEqual(
    getCartVerificationIdentity([
      {
        ...original,
        itemDetail: { ...original.itemDetail, supplierSku: 'supplier-sku' },
      },
    ]),
    originalIdentity,
  );
});
