'use server';

import { getProductDetailsFromSnapshot } from '@/lib/merchizeStorefront/snapshot';
import {
  resolveProviderStorefrontProductCompatibility,
  type ProviderStorefrontProductCompatibilityResolution,
} from '@/lib/merchizeStorefront/currentProductLineCompatibility';
import type {
  ProductResult,
  ProductVariantsInterface,
} from '@/lib/merchizeStorefront/productTypes';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import type {
  CartItemAvailability,
  CartItemAvailabilityMap,
} from '@/components/UI/Shop/Cart/cartAvailability';
import {
  mapCartAvailabilityProducts,
  parseCartAvailabilityInput,
  type CartAvailabilityInputRow,
} from './cartAvailabilityInput';

type SnapshotVariant = ProductVariantsInterface['data'][number];
type HydratedCartItem = {
  cartItem: CartVariant;
  availability: CartItemAvailability;
};
type LocatedCartItem = {
  cartItem: CartVariant;
  snapshot: ProductResult | null;
  snapshotVariant: SnapshotVariant | null;
};
type LiveProductResolution =
  { ok: true; value: ProviderStorefrontProductCompatibilityResolution } | { ok: false };
type LiveCartItemProof = {
  availability: CartItemAvailability;
  productMetaData: ProductResult['productMetaData'] | null;
  variant: SnapshotVariant | null;
  compatibilityResult:
    ProviderStorefrontProductCompatibilityResolution['compatibility']['results'][number] | null;
};

export type HydratedCartDisplayResult = {
  cartItems: CartVariant[];
  availabilityByVariantId: CartItemAvailabilityMap;
};

export async function hydrateCartDisplayFromMerchizeOfflineCatalog(
  cart: CartVariant[],
): Promise<HydratedCartDisplayResult> {
  if (!Array.isArray(cart) || cart.length === 0) {
    return { cartItems: [], availabilityByVariantId: {} };
  }

  const rows = parseCartAvailabilityInput(cart);
  const locatedItems = await Promise.all(
    rows.map(({ cartItem }) => locateSnapshotCartItem(cartItem)),
  );
  const productIds = [...new Set(rows.map((row) => row.productId))];
  const liveProductEntries = await mapCartAvailabilityProducts(
    productIds,
    async (productId) => {
      try {
        const value = await resolveProviderStorefrontProductCompatibility(productId, {
          persist: true,
        });
        return [productId, { ok: true, value } satisfies LiveProductResolution] as const;
      } catch (error) {
        console.warn('[cartAvailability] Live product verification failed:', {
          productId,
          message: error instanceof Error ? error.message : String(error),
        });
        return [productId, { ok: false } satisfies LiveProductResolution] as const;
      }
    },
  );
  const liveProducts = new Map<string, LiveProductResolution>(liveProductEntries);
  const hydratedItems = rows.map((row, index) =>
    hydrateLocatedCartItem(locatedItems[index], resolveLiveCartItemProof(row, liveProducts)),
  );

  return {
    cartItems: hydratedItems.map(({ cartItem }) => cartItem),
    availabilityByVariantId: Object.fromEntries(
      hydratedItems.map(({ cartItem, availability }) => [cartItem.variantId, availability]),
    ),
  };
}

export async function validateCartItemForQuantityIncrease(
  cartItem: CartVariant,
): Promise<CartItemAvailability> {
  const result = await hydrateCartDisplayFromMerchizeOfflineCatalog([cartItem]);
  return result.availabilityByVariantId[cartItem.variantId] ?? { status: 'unverified' };
}

async function locateSnapshotCartItem(cartItem: CartVariant): Promise<LocatedCartItem> {
  try {
    const lookupKeys = getProductLookupKeys(cartItem);

    for (const key of lookupKeys) {
      const snapshot = await getProductDetailsFromSnapshot(key);
      if (!snapshot) continue;

      const snapshotVariant = findMatchingSnapshotVariant(snapshot.productVariants, cartItem);
      if (!snapshotVariant) continue;

      return {
        cartItem,
        snapshot,
        snapshotVariant,
      };
    }

    return {
      cartItem,
      snapshot: null,
      snapshotVariant: null,
    };
  } catch (error) {
    console.warn('[cartAvailability] Failed to load persisted cart display snapshot:', error);
    return {
      cartItem,
      snapshot: null,
      snapshotVariant: null,
    };
  }
}

function resolveLiveCartItemProof(
  row: CartAvailabilityInputRow,
  liveProducts: ReadonlyMap<string, LiveProductResolution>,
): LiveCartItemProof {
  const providerResolution = liveProducts.get(row.productId);
  if (!providerResolution?.ok) {
    return {
      availability: { status: 'unverified' },
      productMetaData: null,
      variant: null,
      compatibilityResult: null,
    };
  }

  const providerProduct = providerResolution.value;
  if (providerProduct.productMetaData._id !== row.productId) {
    return {
      availability: { status: 'unverified' },
      productMetaData: null,
      variant: null,
      compatibilityResult: null,
    };
  }
  const variant = providerProduct.productVariants.find(
    (candidate) => candidate._id === row.variantId,
  );
  if (!variant) {
    return {
      availability: { status: 'unavailable' },
      productMetaData: providerProduct.productMetaData,
      variant: null,
      compatibilityResult: null,
    };
  }

  const compatibilityResult = providerProduct.compatibility.results.find(
    (candidate) => candidate.storefrontVariantId === row.variantId,
  );
  const status =
    compatibilityResult?.status === 'available' && compatibilityResult.supplierSku
      ? 'available'
      : compatibilityResult?.status === 'unavailable'
        ? 'unavailable'
        : 'unverified';

  return {
    availability: { status },
    productMetaData: providerProduct.productMetaData,
    variant,
    compatibilityResult: compatibilityResult ?? null,
  };
}

function hydrateLocatedCartItem(
  locatedItem: LocatedCartItem,
  liveProof: LiveCartItemProof,
): HydratedCartItem {
  const { cartItem, snapshot, snapshotVariant } = locatedItem;
  const displayProduct = liveProof.productMetaData ?? snapshot?.productMetaData ?? null;
  const displayVariant = liveProof.variant ?? snapshotVariant;
  if (!displayProduct || !displayVariant) {
    return { cartItem, availability: liveProof.availability };
  }

  const image = resolveMerchizeImage(displayVariant.image_uris?.[0] ?? cartItem.itemDetail.image);
  return {
    availability: liveProof.availability,
    cartItem: {
      ...cartItem,
      title: displayProduct.title || cartItem.title,
      slug: displayProduct.slug || cartItem.slug,
      itemDetail: {
        ...cartItem.itemDetail,
        ...displayVariant,
        image,
        supplierSku:
          liveProof.availability.status === 'available'
            ? (liveProof.compatibilityResult?.supplierSku ?? undefined)
            : undefined,
      },
    },
  };
}

function getProductLookupKeys(cartItem: CartVariant) {
  return Array.from(
    new Set(
      [
        cartItem.itemDetail.product,
        cartItem.slug,
        cartItem.itemDetail._id === cartItem.itemDetail.product ? cartItem.itemDetail._id : null,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

function findMatchingSnapshotVariant(variants: SnapshotVariant[], cartItem: CartVariant) {
  const variantId = cartItem.variantId || cartItem.itemDetail._id;
  return variants.find((variant) => variant._id === variantId);
}

function resolveMerchizeImage(image: string | null | undefined) {
  if (!image) return undefined;
  return image.startsWith('http') ? image : `https://d2dytk4tvgwhb4.cloudfront.net/${image}`;
}
