import type { CartVariant } from '@/stores/shop_stores/cartStore';

export type CartItemAvailabilityStatus = 'checking' | 'available' | 'unavailable' | 'unverified';

export type CartItemAvailability = {
  status: CartItemAvailabilityStatus;
};

export type CartItemAvailabilityMap = Record<string, CartItemAvailability>;

export function getCartVerificationIdentity(cartItems: readonly CartVariant[]) {
  return JSON.stringify(
    cartItems.map((item) => [
      item.variantId,
      item.quantity,
      item.itemDetail._id,
      item.itemDetail.sku ?? null,
      item.itemDetail.sku_seller ?? null,
      item.itemDetail.supplierSku ?? null,
      item.itemDetail.product ?? null,
      item.slug,
    ]),
  );
}

export function createCartAvailabilityMap(
  cartItems: readonly CartVariant[],
  status: CartItemAvailabilityStatus,
): CartItemAvailabilityMap {
  return Object.fromEntries(cartItems.map((item) => [item.variantId, { status }]));
}

export function getCartItemAvailability(
  availabilityByVariantId: CartItemAvailabilityMap,
  variantId: string,
): CartItemAvailability {
  return availabilityByVariantId[variantId] ?? { status: 'checking' };
}

export function hasCheckoutBlockingCartItems(
  cartItems: readonly CartVariant[],
  availabilityByVariantId: CartItemAvailabilityMap,
) {
  return cartItems.some(
    (item) =>
      getCartItemAvailability(availabilityByVariantId, item.variantId).status !== 'available',
  );
}
