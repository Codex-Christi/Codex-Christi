import type { CartVariant } from '@/stores/shop_stores/cartStore';

export const CART_AVAILABILITY_INPUT_LIMITS = Object.freeze({
  maxRows: 25,
  maxLineQuantity: 25,
  maxTotalQuantity: 100,
  maxIdentifierLength: 128,
  maxConcurrentProductResolutions: 4,
});

export type CartAvailabilityInputRow = {
  cartItem: CartVariant;
  productId: string;
  variantId: string;
  quantity: number;
};

function boundedIdentifier(value: unknown, label: string) {
  const identifier = typeof value === 'string' ? value.trim() : '';
  if (!identifier || identifier.length > CART_AVAILABILITY_INPUT_LIMITS.maxIdentifierLength) {
    throw new Error(`Cart ${label} is invalid.`);
  }
  return identifier;
}

export function parseCartAvailabilityInput(cart: CartVariant[]): CartAvailabilityInputRow[] {
  if (!Array.isArray(cart) || cart.length === 0) return [];
  if (cart.length > CART_AVAILABILITY_INPUT_LIMITS.maxRows) {
    throw new Error('Cart exceeds the availability verification row limit.');
  }

  const rows: CartAvailabilityInputRow[] = [];
  const productByVariantId = new Map<string, string>();
  let totalQuantity = 0;

  for (const cartItem of cart) {
    if (!cartItem || typeof cartItem !== 'object' || !cartItem.itemDetail) {
      throw new Error('Cart row is invalid.');
    }
    const productId = boundedIdentifier(cartItem.itemDetail.product, 'product identity');
    const variantId = boundedIdentifier(cartItem.variantId, 'variant identity');
    const itemDetailVariantId = cartItem.itemDetail._id?.trim();
    if (itemDetailVariantId && itemDetailVariantId !== variantId) {
      throw new Error(`Cart variant ${variantId} has conflicting identity data.`);
    }
    if (
      !Number.isSafeInteger(cartItem.quantity) ||
      cartItem.quantity < 1 ||
      cartItem.quantity > CART_AVAILABILITY_INPUT_LIMITS.maxLineQuantity
    ) {
      throw new Error(`Cart variant ${variantId} has an invalid quantity.`);
    }

    const priorProductId = productByVariantId.get(variantId);
    if (priorProductId) {
      throw new Error(
        priorProductId === productId
          ? `Cart variant ${variantId} is duplicated.`
          : `Cart variant ${variantId} has conflicting product identities.`,
      );
    }
    productByVariantId.set(variantId, productId);

    totalQuantity += cartItem.quantity;
    if (totalQuantity > CART_AVAILABILITY_INPUT_LIMITS.maxTotalQuantity) {
      throw new Error('Cart exceeds the availability verification quantity limit.');
    }
    rows.push({ cartItem, productId, variantId, quantity: cartItem.quantity });
  }

  return rows;
}

export async function mapCartAvailabilityProducts<Input, Output>(
  values: readonly Input[],
  mapper: (value: Input) => Promise<Output>,
) {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    {
      length: Math.min(
        CART_AVAILABILITY_INPUT_LIMITS.maxConcurrentProductResolutions,
        values.length,
      ),
    },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
