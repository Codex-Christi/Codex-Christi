'use client';

import dynamic from 'next/dynamic';
import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { Accordion, AccordionContent, AccordionItem } from '@/components/UI/primitives/accordion';
import { ServerOrderDetailsComponent } from './ServerOrderDetailsComponent';
import { useShopCheckoutStore } from '@/stores/shop_stores/checkoutStore';
import { useCartStore } from '@/stores/shop_stores/cartStore';
import errorToast from '@/lib/error-toast';
import { useShopRouter } from '@/lib/hooks/useShopRouter';
import { useHasMounted } from '@/lib/hooks/useHasMounted';
import { hydrateCartDisplayFromMerchizeOfflineCatalog } from '@/actions/shop/cart/hydrateCartDisplayFromMerchizeOfflineCatalog';
import {
  getCartVerificationIdentity,
  hasCheckoutBlockingCartItems,
} from '../Cart/cartAvailability';
import CustomShopLink from '../HelperComponents/CustomShopLink';

// Dynamic Imports
const CheckoutPageOrderSummary = dynamic(
  () => import('./CheckoutPageOrderSummary').then((comp) => comp.default),
  { ssr: false },
);
const PaymentSection = dynamic(() => import('./PaymentSection').then((comp) => comp.default), {
  ssr: false,
});
const BasicCheckoutInfo = dynamic(
  () => import('./UserCheckoutSummary/BasicCheckoutInfo').then((comp) => comp.BasicCheckoutInfo),
  { ssr: false },
);
export const CheckoutAccordionContext = createContext<{
  handleOpenItem: (itemValue: 'basic-checkout-info' | 'payment-section') => void;
  handleCloseAccordion: () => void;
}>({
  handleCloseAccordion: () => {},
  handleOpenItem: () => {},
});

// Main Component
const CheckoutPage = () => {
  const [openItem, setOpenItem] = useState('basic-checkout-info'); // State to hold the value of the open item (string for single type)
  const cartVariants = useCartStore((state) => state.variants);
  const { push } = useShopRouter();
  const hasMounted = useHasMounted();
  const [cartHydrated, setCartHydrated] = useState(false);
  const [hasRedirected, setHasRedirected] = useState(false);
  const cartCount = useMemo(() => cartVariants.length, [cartVariants]);
  const cartIdentity = useMemo(() => getCartVerificationIdentity(cartVariants), [cartVariants]);
  const [availabilityGate, setAvailabilityGate] = useState<{
    cartIdentity: string | null;
    status: 'available' | 'blocked';
  }>({ cartIdentity: null, status: 'blocked' });
  const availabilityGateStatus =
    availabilityGate.cartIdentity === cartIdentity ? availabilityGate.status : 'checking';

  const triggerEmptyCartRedirect = useCallback(() => {
    if (hasRedirected) return;
    setHasRedirected(true);
    errorToast({
      header: 'Cart empty',
      message: 'Add items to your cart before checking out.',
    });
    push('/shop/cart');
  }, [hasRedirected, push]);

  const triggerUnavailableCartRedirect = useCallback(() => {
    if (hasRedirected) return;
    setHasRedirected(true);
    errorToast({
      header: 'Cart needs attention',
      message: 'Remove unavailable items or choose another available option before checkout.',
    });
    push('/shop/cart');
  }, [hasRedirected, push]);

  // useEffects
  // Manually rehydrate the useShopCheckoutStore
  useEffect(() => {
    useShopCheckoutStore.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (!cartHydrated || hasRedirected) return;
    if (cartCount > 0) return;

    const redirectTimer = window.setTimeout(() => {
      triggerEmptyCartRedirect();
    }, 0);

    return () => window.clearTimeout(redirectTimer);
  }, [cartHydrated, cartCount, hasRedirected, triggerEmptyCartRedirect]);

  useEffect(() => {
    if (!cartHydrated || hasRedirected || cartVariants.length === 0) return;

    let active = true;
    hydrateCartDisplayFromMerchizeOfflineCatalog(cartVariants)
      .then(({ availabilityByVariantId }) => {
        if (!active) return;

        const isBlocked = hasCheckoutBlockingCartItems(cartVariants, availabilityByVariantId);
        setAvailabilityGate({
          cartIdentity,
          status: isBlocked ? 'blocked' : 'available',
        });
        if (isBlocked) triggerUnavailableCartRedirect();
      })
      .catch((error) => {
        console.warn('[CheckoutPage] Cart availability verification failed:', error);
        if (!active) return;
        setAvailabilityGate({ cartIdentity, status: 'blocked' });
        triggerUnavailableCartRedirect();
      });

    return () => {
      active = false;
    };
  }, [cartHydrated, cartIdentity, cartVariants, hasRedirected, triggerUnavailableCartRedirect]);

  useEffect(() => {
    if (cartHydrated) return;

    const markHydrated = () => {
      setCartHydrated(true);
    };

    if (useCartStore.persist?.hasHydrated?.()) {
      markHydrated();
      return;
    }

    const unsub = useCartStore.persist?.onFinishHydration?.(() => {
      markHydrated();
    });

    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [cartHydrated]);

  const handleOpenItem = (itemValue: 'basic-checkout-info' | 'payment-section') => {
    setOpenItem(itemValue); // Update the state to open the desired item
  };

  const handleCloseAccordion = () => {
    setOpenItem(''); // Update the state to close the accordion
  };

  if (!cartHydrated || cartCount === 0 || availabilityGateStatus !== 'available') {
    return (
      <section
        className='mx-auto my-12 w-[min(92vw,42rem)] rounded-2xl border border-white/10 bg-[#4C3D3D3D] p-8 text-center text-white backdrop-blur-[10px]'
        aria-live='polite'
        aria-busy={availabilityGateStatus === 'checking'}
      >
        <h1 className='text-2xl font-bold'>Checking your cart</h1>
        <p className='mt-3 text-white/75'>
          {availabilityGateStatus === 'checking'
            ? 'Confirming that every selected option is still available…'
            : 'Your cart needs attention before checkout.'}
        </p>
        {availabilityGateStatus === 'blocked' && (
          <CustomShopLink
            href='/shop/cart'
            className='mt-5 inline-flex rounded-full bg-white px-5 py-3 font-semibold text-black'
          >
            Return to cart
          </CustomShopLink>
        )}
      </section>
    );
  }

  // JSX
  return (
    <ServerOrderDetailsComponent>
      <CheckoutAccordionContext.Provider value={{ handleCloseAccordion, handleOpenItem }}>
        <div className='grid grid-cols-1 gap-8 items-start px-2 py-12 md:px-[20px] lg:px-[24px] min-h-dvh lg:grid-cols-12'>
          <div className='bg-[#4C3D3D3D] backdrop-blur-[10px] pt-10 !px-2 rounded-[10px] md:p-10 space-y-8 lg:col-span-7'>
            {hasMounted ? (
              <Accordion type='single' value={openItem} onValueChange={setOpenItem}>
                {/* User Checkout Info Section */}
                <AccordionItem value='basic-checkout-info' className='border-none px-4'>
                  {/* Note: AccordionTrigger is not needed if you only want programmable control */}
                  <AccordionContent className='w-full'>
                    <BasicCheckoutInfo />
                  </AccordionContent>
                </AccordionItem>

                {/* Payment details section */}
                <AccordionItem value='payment-section' className='border-none px-4'>
                  {/* Note: AccordionTrigger is not needed if you only want programmable control */}
                  <AccordionContent>
                    <PaymentSection />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            ) : null}
          </div>

          {/* Order Summary, on it's own */}
          <CheckoutPageOrderSummary />
        </div>
      </CheckoutAccordionContext.Provider>
    </ServerOrderDetailsComponent>
  );
};

export default CheckoutPage;
