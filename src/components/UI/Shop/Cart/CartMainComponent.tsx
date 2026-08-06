'use client';

import { useCartStore } from '@/stores/shop_stores/cartStore';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { hydrateCartDisplayFromMerchizeOfflineCatalog } from '@/actions/shop/cart/hydrateCartDisplayFromMerchizeOfflineCatalog';
import {
  createCartAvailabilityMap,
  getCartVerificationIdentity,
  hasCheckoutBlockingCartItems,
  type CartItemAvailabilityMap,
  type CartItemAvailabilityStatus,
} from './cartAvailability';

type CartDisplayState = {
  cartIdentity: string | null;
  cartItems: CartVariant[];
  availabilityByVariantId: CartItemAvailabilityMap;
};

// Dynamic Imports
const CartEmptyComponent = dynamic(
  () => import('./CartEmptyComponent').then((mod) => mod.CartEmptyComponent),
  {
    ssr: false,
  },
);
const CartItems = dynamic(() => import('./CartItems').then((mod) => mod.default), {
  ssr: false,
});
const OrderSummary = dynamic(() => import('./OrderSummary').then((mod) => mod.default), {
  ssr: false,
});

// Main component
const CartMainComponent = () => {
  // Hooks
  // Hooks
  const { variants } = useCartStore((state) => state);
  const cartIdentity = useMemo(() => getCartVerificationIdentity(variants), [variants]);
  const [cartDisplayState, setCartDisplayState] = useState<CartDisplayState>({
    cartIdentity: null,
    cartItems: [],
    availabilityByVariantId: {},
  });
  const isCartEmpty = useMemo(() => variants.length === 0, [variants.length]);
  const displayStateIsCurrent = cartDisplayState.cartIdentity === cartIdentity;
  const availabilityByVariantId = useMemo(
    () =>
      displayStateIsCurrent
        ? cartDisplayState.availabilityByVariantId
        : createCartAvailabilityMap(variants, 'checking'),
    [cartDisplayState.availabilityByVariantId, displayStateIsCurrent, variants],
  );
  const cartItemsForDisplay = useMemo(
    () =>
      isCartEmpty
        ? []
        : displayStateIsCurrent && cartDisplayState.cartItems.length === variants.length
          ? cartDisplayState.cartItems
          : variants,
    [cartDisplayState.cartItems, displayStateIsCurrent, isCartEmpty, variants],
  );
  const checkoutBlocked = useMemo(
    () => hasCheckoutBlockingCartItems(variants, availabilityByVariantId),
    [availabilityByVariantId, variants],
  );
  const handleAvailabilityChange = useCallback(
    (variantId: string, status: CartItemAvailabilityStatus) => {
      setCartDisplayState((current) =>
        current.cartIdentity === cartIdentity
          ? {
              ...current,
              availabilityByVariantId: {
                ...current.availabilityByVariantId,
                [variantId]: { status },
              },
            }
          : current,
      );
    },
    [cartIdentity],
  );

  useEffect(() => {
    let active = true;

    if (variants.length === 0) return;

    hydrateCartDisplayFromMerchizeOfflineCatalog(variants)
      .then(({ cartItems, availabilityByVariantId: availability }) => {
        if (!active) return;
        setCartDisplayState({
          cartIdentity,
          cartItems,
          availabilityByVariantId: availability,
        });
      })
      .catch((error) => {
        console.warn('[CartMainComponent] Offline catalog cart hydration failed:', error);
        if (!active) return;
        setCartDisplayState({
          cartIdentity,
          cartItems: variants,
          availabilityByVariantId: createCartAvailabilityMap(variants, 'unverified'),
        });
      });

    return () => {
      active = false;
    };
  }, [cartIdentity, variants]);

  // JSX
  return (
    <div
      className='px-2 py-4 md:px-[20px] lg:px-[24px] mx-auto mt-5 flex
    flex-col lg:flex-row gap-6 xl:gap-10'
    >
      {/* Container for cart contents */}
      <div
        className='bg-[#3D3D3D4D] backdrop-blur-[5px] text-white rounded-[20px] 
          min-h-[20svh] w-full sm:w-[85vw] md:w-[85vw] mx-auto lg:!w-[90vw] xl:!w-[85vw] py-8
          justify-center'
      >
        {/* Cart Title */}
        <h1 className=' font-light text-white text-4xl font-ocr text-left mb-4 pl-5'>
          Your Cart{' '}
          {!isCartEmpty ? `(${variants.length} item${variants.length > 1 ? 's' : ''})` : ''}
        </h1>

        {isCartEmpty && <CartEmptyComponent />}

        {/* If the cart is not empty, render the cart items */}
        {!isCartEmpty && variants && (
          <div className='flex flex-col gap-8 max-h-[90vh] px-5 overflow-y-auto scrollbar'>
            {/* All Cart Items */}
            <CartItems
              cartItems={cartItemsForDisplay}
              availabilityByVariantId={availabilityByVariantId}
              onAvailabilityChange={handleAvailabilityChange}
            />
          </div>
        )}
      </div>

      {/* Conatiner for Order Summary */}
      {!isCartEmpty && variants && (
        <OrderSummary cartItemsOverride={cartItemsForDisplay} checkoutBlocked={checkoutBlocked} />
      )}
    </div>
  );
};

export default CartMainComponent;
