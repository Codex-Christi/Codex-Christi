import { firstStringValue, toMerchizeThumbnailUrl } from '@/lib/merchizeStorefront/imageUrls';
import type {
  ProductOption,
  ProductVariantsInterface,
} from '@/lib/merchizeStorefront/productTypes';
import type { StorefrontVariantCompatibilityResult } from '@/lib/merchizeStorefront/productLineCompatibility';
import { isMerchizeStorefrontVariantAvailable } from './merchizeAvailability';
import type { TrustedProviderProduct } from './resolver';

function normalizeSelectedOptions(options: ProductOption[]) {
  return options
    .map((option) => {
      const attributeName = option.attribute?.name;
      const name =
        typeof attributeName === 'string' && attributeName.trim()
          ? attributeName.trim()
          : option.name?.trim();
      const value = option.name?.trim() || option.value?.trim();
      return name && value ? { name, value } : null;
    })
    .filter((option): option is { name: string; value: string } => option !== null);
}

export function mapCompatibleMerchizeVariants({
  variants,
  livePrices,
  compatibilityResults,
}: {
  variants: ProductVariantsInterface['data'];
  livePrices: ReadonlyMap<string, number>;
  compatibilityResults: StorefrontVariantCompatibilityResult[];
}): TrustedProviderProduct['variants'] {
  const compatibilityByVariantId = new Map(
    compatibilityResults.map((result) => [result.storefrontVariantId, result]),
  );

  return variants.flatMap((variant) => {
    const proof = compatibilityByVariantId.get(variant._id);
    if (
      proof?.status !== 'available' ||
      !proof.supplierProductId ||
      !proof.supplierVariantId ||
      !proof.supplierSku ||
      !isMerchizeStorefrontVariantAvailable(variant)
    ) {
      return [];
    }

    return [
      {
        variantId: variant._id,
        productId: variant.product,
        supplierProductId: proof.supplierProductId,
        supplierVariantId: proof.supplierVariantId,
        // Supplier identity drives catalog, shipping, and fulfillment. The storefront SKU stays
        // separate as the seller/display identity that the customer selected.
        sku: proof.supplierSku,
        sellerSku: variant.sku.trim() || variant.sku_seller?.trim() || null,
        title: variant.title,
        selectedOptions: normalizeSelectedOptions(variant.options),
        imageUrl: toMerchizeThumbnailUrl(firstStringValue(variant.image_uris)),
        unitPriceUsd: livePrices.get(variant._id) ?? Number.NaN,
        priceSource: 'live' as const,
        isAvailable: true,
      },
    ];
  });
}
