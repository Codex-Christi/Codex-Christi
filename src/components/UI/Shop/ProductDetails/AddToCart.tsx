'use client';

import React, { FC, use, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../primitives/button';
import { useCartStore } from '@/stores/shop_stores/cartStore';
import {
  getRequiredVariantAttributes,
  hasRequiredVariantSelections,
  setupVariantAutoMatching,
  useCurrentVariant,
} from './currentVariantStore';
import { OptionalProductVariantProps, ProductDetailsContext } from '.';
import CustomShopLink from '../HelperComponents/CustomShopLink';
import { useShallow } from 'zustand/react/shallow';
import { checkProductLineAvail } from '@/actions/shop/product/[each]/checkProdLineAvail';

// ——— Types ———
type Variant = NonNullable<OptionalProductVariantProps['variants'][number]>;

// 1) Type guard to drop undefineds and satisfy TS narrowing on .filter
function isVariant(v: OptionalProductVariantProps['variants'][number] | undefined): v is Variant {
  return !!v && typeof v._id === 'string' && Array.isArray(v.options);
}

const REQUIRED_ATTRIBUTE_LABELS: Record<string, string> = {
  size: 'size',
  color: 'color',
  label: 'label',
};

function formatRequiredAttributes(attributes: readonly string[]) {
  const labels = attributes.map((attribute) => REQUIRED_ATTRIBUTE_LABELS[attribute] ?? attribute);

  if (labels.length === 1) return `a ${labels[0]}`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

// Main Component
export const AddToCart: FC<OptionalProductVariantProps> = (props) => {
  // Always read context at top-level (ok even if no provider)
  const ctx = use(ProductDetailsContext);

  // Prefer explicit props; fall back to context. Avoid non-null assertions.
  const productVariants = useMemo(
    () => (props.variants ?? ctx?.productVariants ?? []) as (Variant | undefined)[],
    [props.variants, ctx?.productVariants],
  );

  // 2) Create a cleaned array with proper type Variant[]
  const cleanVariants = useMemo(() => productVariants.filter(isVariant), [productVariants]);

  const title = props.productMetaData?.title ?? ctx?.productMetaData?.title ?? '';
  const slug = props.productMetaData?.slug ?? ctx?.productMetaData?.slug ?? '';

  // ---- Zustand selections with shallow memoization (one subscription) ----
  const { matchingVariant, setMatchingVariant, resetVariantOptions, currentVariantOptions } =
    useCurrentVariant(
      useShallow((s) => ({
        matchingVariant: s.matchingVariant,
        setMatchingVariant: s.setMatchingVariant,
        resetVariantOptions: s.resetVariantOptions,
        currentVariantOptions: s.currentVariantOptions,
      })),
    );

  const addToCart = useCartStore((s) => s.addToCart);

  // Keep only one verification/add operation in flight.
  const [isBusy, setIsBusy] = useState(false);
  const isLoadingVariants = props.isLoadingVariants ?? ctx?.variantLoadState === 'loading';
  const requiredAttributes = useMemo(
    () =>
      getRequiredVariantAttributes(cleanVariants as Parameters<typeof setupVariantAutoMatching>[0]),
    [cleanVariants],
  );
  const hasAllRequiredSelections = hasRequiredVariantSelections(
    requiredAttributes,
    currentVariantOptions,
  );
  const matchingVariantIsCurrent = Boolean(
    matchingVariant &&
    cleanVariants.some(
      (variant) => variant._id === matchingVariant._id && variant.sku === matchingVariant.sku,
    ),
  );

  // Use the cleaned array for messaging & indexing
  const selectOptionsMessage = useMemo(() => {
    if (isLoadingVariants) return 'Product options are still loading.';
    if (cleanVariants.length === 0) return 'This item is unavailable.';
    if (requiredAttributes.length === 0) {
      return 'This item does not have a selectable available option.';
    }
    return `Please select ${formatRequiredAttributes(requiredAttributes)} before adding to cart.`;
  }, [cleanVariants.length, isLoadingVariants, requiredAttributes]);

  const canSubmit =
    Boolean(matchingVariant?._id) &&
    matchingVariantIsCurrent &&
    hasAllRequiredSelections &&
    !isLoadingVariants;

  const addToCartHandler = useCallback(async () => {
    // Keep one verification/add operation in flight at a time.
    if (isBusy) return;
    setIsBusy(true);

    try {
      const fail = async (message: string) => {
        await showAddToCartErrorToast({ message });
      };

      if (!canSubmit || !matchingVariant) {
        await fail(selectOptionsMessage);
        return;
      }

      const lineCheckResp = await checkProductLineAvail({
        storefrontProductId: matchingVariant.product,
        storefrontVariantId: matchingVariant._id,
      });

      if (!lineCheckResp?.ok) {
        await fail(
          'We could not verify availability for production. Please try again in a moment.',
        );
        return;
      }

      if (!lineCheckResp.isAvailable) {
        await fail(
          'This exact variant is not available for production right now. Please pick a different available option.',
        );
        return;
      }

      addToCart({
        variantId: matchingVariant._id,
        quantity: 1,
        itemDetail: matchingVariant,
        title,
        slug,
      });

      await cartSuccessToast({ message: 'Item added to cart successfully.' });

      setMatchingVariant(null);
    } catch (err: unknown) {
      await showAddToCartErrorToast({
        message:
          typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err),
      });
    } finally {
      setIsBusy(false);
      resetVariantOptions();
    }
  }, [
    addToCart,
    canSubmit,
    isBusy,
    matchingVariant,
    resetVariantOptions,
    selectOptionsMessage,
    setMatchingVariant,
    slug,
    title,
  ]);

  // if (!variantLineProductName) return;

  // Subscribes with a proper Variant[]; auto-unsub on deps change/unmount.
  useEffect(() => {
    if (cleanVariants.length === 0) return;

    // Adapt local Variant[] to the shape expected by setupVariantAutoMatching
    const unsubscribe = setupVariantAutoMatching(
      cleanVariants as Parameters<typeof setupVariantAutoMatching>[0],
    );
    return () => {
      resetVariantOptions();
      unsubscribe();
    };
  }, [cleanVariants, resetVariantOptions]);

  // Main JSX
  return (
    <Button
      className='bg-white hover:bg-white rounded-lg !py-6 !px-8 flex items-center justify-between w-full'
      name='Add to Cart'
      aria-label='Add to Cart'
      onClick={addToCartHandler}
      disabled={!canSubmit || isBusy}
    >
      <h3 className='font-bold text-xl text-black text-center inline-block mx-auto'>
        {isLoadingVariants
          ? 'Loading Options…'
          : cleanVariants.length === 0
            ? 'Unavailable'
            : !canSubmit
              ? 'Select Options'
              : isBusy
                ? 'Adding…'
                : 'Add to Cart'}
      </h3>

      <svg width='28' height='26' viewBox='0 0 28 26' aria-hidden='true' fill='none'>
        <path
          d='M8.94927 21.1599C10.0096 21.1599 10.8692 22.0195 10.8692 23.0799C10.8692 24.1402 10.0096 24.9998 8.94927 24.9998C7.88889 24.9998 7.0293 24.1402 7.0293 23.0799C7.0293 22.0195 7.88889 21.1599 8.94927 21.1599Z'
          stroke='black'
          strokeWidth='2'
        />
        <path
          d='M20.4707 21.1602C21.5311 21.1602 22.3907 22.0197 22.3907 23.0801C22.3907 24.1405 21.5311 25.0001 20.4707 25.0001C19.4104 25.0001 18.5508 24.1405 18.5508 23.0801C18.5508 22.0197 19.4104 21.1602 20.4707 21.1602Z'
          stroke='black'
          strokeWidth='2'
        />
        <path
          d='M2.22787 1.05461C1.72769 0.87875 1.17967 1.14167 1.00382 1.64183C0.827969 2.14201 1.09089 2.69004 1.59105 2.86588L2.22787 1.05461ZM25.7911 10.77L26.7312 10.9639L26.7325 10.958L25.7911 10.77ZM6.65573 10.6129V7.12926H4.73576V10.6129H6.65573ZM2.56221 1.17215L2.22787 1.05461L1.59105 2.86588L1.9254 2.98343L2.56221 1.17215ZM13.3493 18.92H20.1369V17H13.3493V18.92ZM6.65573 7.12926C6.65573 6.22411 6.65703 5.46879 6.59059 4.855C6.52181 4.21965 6.37281 3.64018 6.01188 3.11201L4.42668 4.19525C4.54221 4.36432 4.63143 4.59654 4.68177 5.06162C4.73445 5.54828 4.73576 6.18214 4.73576 7.12926H6.65573ZM1.9254 2.98343C2.77992 3.28387 3.34151 3.48297 3.75476 3.68573C4.14287 3.87617 4.31397 4.03031 4.42668 4.19525L6.01188 3.11201C5.64814 2.57971 5.1645 2.2388 4.6005 1.96207C4.0616 1.69765 3.37369 1.45745 2.56221 1.17215L1.9254 2.98343ZM4.73576 10.6129C4.73576 12.4721 4.7532 13.8127 4.92862 14.837C5.11591 15.9304 5.48984 16.7134 6.18901 17.4508L7.5823 16.1299C7.1725 15.6976 6.95147 15.2743 6.82104 14.5129C6.67875 13.682 6.65573 12.5188 6.65573 10.6129H4.73576ZM13.3493 17C11.5358 17 10.2775 16.9977 9.32945 16.8633C8.41451 16.7335 7.93115 16.4977 7.5823 16.1299L6.18901 17.4508C6.94914 18.2526 7.91272 18.6016 9.05989 18.7642C10.174 18.9223 11.593 18.92 13.3493 18.92V17ZM5.69574 6.91376H21.2228V4.99379H5.69574V6.91376ZM24.8508 10.5762L24.2112 13.6799L26.0916 14.0674L26.7312 10.9639L24.8508 10.5762ZM21.2228 6.91376C22.319 6.91376 23.2837 6.91504 24.045 7.00015C24.4234 7.04244 24.7065 7.10119 24.9054 7.1711C25.112 7.24369 25.1449 7.29938 25.1284 7.27777L26.6502 6.10709C26.3494 5.71616 25.9265 5.49484 25.542 5.3597C25.1497 5.22186 24.706 5.1421 24.2584 5.09207C23.3678 4.99251 22.2834 4.99379 21.2228 4.99379V6.91376ZM26.7325 10.958C26.949 9.87265 27.133 8.96203 27.178 8.23263C27.2242 7.4823 27.1389 6.74246 26.6502 6.10709M26.7325 10.958L24.8496 10.5821C25.0773 9.44144 25.2266 8.68258 25.2617 8.11434C25.2954 7.56702 25.2078 7.38106 25.1284 7.27777M25.1513 13.8736L26.0916 14.0674M26.0916 14.0674L24.2112 13.6799M26.0916 14.0674C25.8947 15.0223 25.7313 15.824 25.5191 16.4537C25.2984 17.1083 24.9925 17.6838 24.4466 18.1287M25.8892 6.69243L25.1284 7.27777M25.1284 7.27777C25.1449 7.29938 25.112 7.24369 24.9054 7.1711C24.7065 7.10119 24.4234 7.04244 24.045 7.00015C23.2837 6.91504 22.319 6.91376 21.2228 6.91376M25.1284 7.27777L26.6502 6.10709M23.8401 17.3845L23.2337 16.6403M23.2337 16.6403L24.4466 18.1287M23.2337 16.6403C23.0734 16.7709 22.8462 16.8752 22.3564 16.9352C21.8403 16.9983 21.16 17 20.1369 17M23.2337 16.6403C23.3939 16.5098 23.542 16.3082 23.6996 15.8406C23.8656 15.3479 24.0046 14.6818 24.2112 13.6799M6.65573 10.6129V7.12926M6.65573 10.6129H4.73576M6.65573 10.6129C6.65573 12.5188 6.67875 13.682 6.82104 14.5129C6.95147 15.2743 7.1725 15.6976 7.5823 16.1299M6.65573 7.12926H4.73576M4.73576 7.12926V10.6129M4.73576 7.12926C4.73576 6.18214 4.73445 5.54828 4.68177 5.06162C4.63143 4.59654 4.54221 4.36432 4.42668 4.19525M1.9254 2.98343C2.77992 3.28387 3.34151 3.48297 3.75476 3.68573C4.14287 3.87617 4.31397 4.03031 4.42668 4.19525M13.3493 18.92H20.1369M13.3493 18.92V17M20.1369 18.92V17M20.1369 18.92C21.1118 18.92 21.93 18.9216 22.5896 18.8409C23.2753 18.757 23.9007 18.5736 24.4466 18.1287M20.1369 17H13.3493M13.3493 17C11.5358 17 10.2775 16.9977 9.32945 16.8633C8.41451 16.7335 7.93115 16.4977 7.5823 16.1299M21.2228 6.91376H5.69574V4.99379H21.2228M21.2228 6.91376V4.99379M21.2228 4.99379C22.2834 4.99379 23.3678 4.99251 24.2584 5.09207C24.706 5.1421 25.1497 5.22186 25.542 5.3597C25.9265 5.49484 26.3494 5.71616 26.6502 6.10709'
          stroke='black'
        />
      </svg>
    </Button>
  );
};

type Position = 'top-right';

async function showAddToCartErrorToast({ message }: { message: string }) {
  const { default: errorToast } = await import('@/lib/error-toast');
  errorToast({ message });
}

const cartSuccessToast = async ({
  message,
  header = 'Action Successful!',
  position = 'top-right',
}: {
  message: string;
  header?: string;
  position?: Position;
}) => {
  const { toast } = await import('sonner');
  const toastID = toast.success(header, {
    description: message,
    action: (
      <CustomShopLink
        id='view-cart-toast-button'
        href='/shop/cart'
        className='ml-auto bg-black text-white text-[.8rem] px-2 py-1 rounded-lg font-bold !border border-black shadow-md shadow-black'
      >
        View Cart
      </CustomShopLink>
    ),
    position,
  });

  return toastID;
};
