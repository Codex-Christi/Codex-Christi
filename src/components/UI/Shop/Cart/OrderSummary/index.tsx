'use client';

import { useCartStore } from '@/stores/shop_stores/cartStore';
import type { CartVariant } from '@/stores/shop_stores/cartStore';
import Link from 'next/link';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { FaAngleRight } from 'react-icons/fa6';
import CustomShopLink from '../../HelperComponents/CustomShopLink';
import { useShopCheckoutStore } from '@/stores/shop_stores/checkoutStore';
import GlobalProductPrice from '../../GlobalShopComponents/GlobalProductPrice';
import { Button } from '@/components/UI/primitives/button';

type OrderSummaryProps = {
  /** ISO-3 destination country code, e.g. 'USA', 'GBR', 'CAN'. Defaults to 'USA'. */
  countryIso3?: string;
  cartItemsOverride?: CartVariant[];
  checkoutBlocked?: boolean;
};

type ShippingEstimate = {
  /** USD amount for FX conversions */
  max: number;
};

// Main Component
const OrderSummary: FC<OrderSummaryProps> = ({
  countryIso3 = 'USA',
  cartItemsOverride,
  checkoutBlocked = false,
}) => {
  // Hooks
  const { variants: storeCartItems } = useCartStore();
  const cartItems = cartItemsOverride ?? storeCartItems;
  const country = useShopCheckoutStore((state) => state.delivery_address.shipping_country);
  const shippingState = useShopCheckoutStore((state) => state.delivery_address.shipping_state);

  const subTotal = useMemo(
    () =>
      cartItems.reduce((acc, { itemDetail: { retail_price }, quantity }) => {
        return acc + retail_price * quantity;
      }, 0),
    [cartItems],
  );
  const [shippingEstimates, setShippingEstimates] = useState<ShippingEstimate | null>(null);

  //   Funcs
  const getShippingEstimates = useCallback(async () => {
    if (!cartItems.length || checkoutBlocked) return null;

    try {
      const res = await fetch('/next-api/shop/cart/shipping-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cart: cartItems,
          countryIso3: (country ?? countryIso3).toUpperCase(),
          stateIso2: shippingState,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch shipping estimate (${res.status})`);
      }

      const data = await res.json();
      const totals = data?.totals;

      if (!totals || typeof totals.shippingPriceNum !== 'number') return null;

      const multiplier = typeof totals?.multiplier === 'number' ? totals.multiplier : null;
      const usdBase =
        multiplier && multiplier > 0
          ? totals.shippingPriceNum / multiplier
          : totals.shippingPriceNum;

      return {
        max: Number(Math.max(usdBase, 0).toFixed(2)),
      };
    } catch (error) {
      console.error('[OrderSummary] Failed to fetch shipping estimates:', error);
      return null;
    }
  }, [cartItems, checkoutBlocked, country, countryIso3, shippingState]);

  //   UseEffects
  useEffect(() => {
    async function fetchShippingEstimates() {
      const estimates = await getShippingEstimates();
      if (estimates) {
        setShippingEstimates(estimates);
      } else {
        setShippingEstimates(null);
      }
    }
    fetchShippingEstimates();
  }, [getShippingEstimates]);

  const estimatedTotal = subTotal + (shippingEstimates?.max ?? 0);

  // JSX
  return (
    <section
      className='bg-[#3D3D3D4D] backdrop-blur-[5px] text-white rounded-[20px] 
     w-full sm:w-[85vw] md:w-[80vw] lg:!w-[35%] xl:!w-[32.5%] py-8 lg:self-start mx-auto
     px-5 flex flex-col select-none md:sticky md:top-6'
    >
      {/* Header */}
      <h1
        className=' font-light text-white text-4xl font-ocr text-left mb-4
      underline underline-offset-[1.5rem] lg:no-underline xl:underline select-none'
      >
        Order Summary
      </h1>

      <div className='pt-8 font-semibold flex flex-wrap gap-3 text-xl items-center max-[1289px]:text-lg'>
        <span className='flex-1 min-w-[55%]'>Subtotal</span>
        <GlobalProductPrice className='flex-1 min-w-[35%] text-right' usdAmount={subTotal} />
      </div>

      {shippingEstimates && (
        <>
          <div className='pt-2 font-semibold flex flex-wrap gap-3 text-lg items-center max-[1289px]:text-base'>
            <span className='flex-1 min-w-[55%]'>
              Est. Shipping Fee <span className='font-extrabold'>**</span>
            </span>
            <GlobalProductPrice
              className='flex-1 min-w-[35%] text-right px-0'
              usdAmount={shippingEstimates.max}
            />
          </div>

          <p className='font-semibold pt-8 leading-relaxed text-sm sm:text-base'>
            <span className='font-extrabold'>**</span> &nbsp; Shipping fee varies by location.{' '}
            <br />
            <Link
              className='font-normal text-blue-200 underline underline-offset-2'
              href='/shop/help/shipping-rates-and-supported-countries'
              target='_blank'
            >
              Learn more
            </Link>
          </p>
        </>
      )}

      {!shippingEstimates && (
        <p className='text-sm text-white/60 pt-6'>
          Shipping is calculated at checkout once we know your delivery details.
        </p>
      )}

      <div className='mt-8 border-t border-white/10 pt-6 flex flex-wrap gap-3 items-center text-xl font-semibold max-[1289px]:text-xl'>
        <span className='flex-1 min-w-[55%]'>Estimated Total</span>
        <GlobalProductPrice className='flex-1 min-w-[35%] text-right' usdAmount={estimatedTotal} />
      </div>

      {checkoutBlocked ? (
        <>
          <p role='alert' className='pt-6 text-sm font-semibold text-amber-200'>
            Remove unavailable items or choose another available option before checkout.
          </p>
          <Button
            name='Proceed to Checkout'
            type='button'
            disabled
            aria-disabled='true'
            className='w-[95%] text-center !mx-auto py-4 px-4 text-xl mt-4 rounded-3xl bg-white text-black gap-2 !flex justify-center items-center'
          >
            <span>Proceed to Checkout</span> <FaAngleRight size={22.5} />
          </Button>
        </>
      ) : (
        <CustomShopLink
          href='/shop/checkout'
          className='w-[95%] text-center !mx-auto py-4 px-4 text-xl mt-10 rounded-3xl bg-white text-black hover:bg-gray-200 gap-2 !flex justify-center items-center'
        >
          <h4>Proceed to Checkout</h4> <FaAngleRight size={22.5} />
        </CustomShopLink>
      )}
    </section>
  );
};

export default OrderSummary;
