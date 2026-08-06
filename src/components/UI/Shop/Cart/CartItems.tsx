import { ProductVariantOptions } from '@/lib/merchizeStorefront/productTypes';
import { CartVariant, useCartStore } from '@/stores/shop_stores/cartStore';
import React, { FC, useState } from 'react';
import Image from 'next/image';
import SizeAndColorElem from './SizeAndColor';
import { ItemQuantityComponent } from './ItemQuantityComponent';
import CustomShopLink from '@/components/UI/Shop/HelperComponents/CustomShopLink';
import { Button } from '@/components/UI/primitives/button';
import { Trash2 } from 'lucide-react';
import GlobalProductPrice from '../GlobalShopComponents/GlobalProductPrice';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/UI/primitives/alert-dialog';
import {
  getCartItemAvailability,
  type CartItemAvailabilityStatus,
  type CartItemAvailabilityMap,
} from './cartAvailability';

const CartItems: FC<{
  cartItems: CartVariant[];
  availabilityByVariantId: CartItemAvailabilityMap;
  onAvailabilityChange?: (variantId: string, status: CartItemAvailabilityStatus) => void;
}> = ({ cartItems, availabilityByVariantId, onAvailabilityChange }) => {
  const { removeFromCart } = useCartStore();

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleConfirmRemove = () => {
    if (!pendingRemoveId) return;
    const id = pendingRemoveId;
    setPendingRemoveId(null);
    setRemovingId(id);

    // Fade out, then actually remove from the cart.
    setTimeout(() => {
      removeFromCart(id);
      setRemovingId((current) => (current === id ? null : current));
    }, 200);
  };

  const renderRemoveButton = (variantId: string) => (
    <Button
      type='button'
      variant='outline'
      size='sm'
      aria-label='Remove item from cart'
      title='Remove item from cart'
      name='Remove item from cart'
      className='flex items-center gap-1 font-semibold border-red-400 text-red-400 hover:text-red-200 hover:bg-destructive/30 bg-transparent'
      onClick={() => setPendingRemoveId(variantId)}
    >
      <Trash2 className='h-4 w-4' />
      <span>Remove</span>
    </Button>
  );

  return (
    <>
      {cartItems.map((cartItem) => {
        const { itemDetail: variant, title, quantity } = cartItem;
        const productTitle = title;
        const { image, retail_price, options, product: parentID } = variant;
        const availability = getCartItemAvailability(availabilityByVariantId, cartItem.variantId);
        const canIncreaseQuantity = availability.status === 'available';
        const isUnavailable = availability.status === 'unavailable';
        const isUnverified = availability.status === 'unverified';
        const isChecking = availability.status === 'checking';
        const productLookupKey = parentID || cartItem.slug;
        const productHref = `/shop/product/${encodeURIComponent(productLookupKey)}`;

        const lineTotal = retail_price * quantity;

        return (
          <div
            key={cartItem.variantId}
            className={`bg-transparent px-0 md:px-4 my-4 rounded-l w-full mx-auto
            grid grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-3 select-none 
            transition-opacity duration-200
            ${isUnavailable || isUnverified ? 'rounded-xl border border-amber-300/40 py-3' : ''}
            ${removingId === cartItem.variantId ? 'opacity-0' : 'opacity-100'}`}
          >
            {/* Item Image */}
            {image && (
              <CustomShopLink href={productHref}>
                <Image
                  src={image}
                  className='rounded-xl hover:cursor-pointer'
                  width={90}
                  height={90}
                  alt={productTitle}
                />
              </CustomShopLink>
            )}

            {/* Title & price */}
            <section
              className='text-left flex flex-col justify-around col-span-2 
              md:col-span-2 xl:col-span-3 hover:cursor-pointer'
            >
              <CustomShopLink href={productHref}>
                <h3 className='text-lg font-semibold hover:underline underline-offset-8'>
                  {productTitle}
                </h3>
              </CustomShopLink>

              {isUnavailable && (
                <div role='status' className='mt-2 space-y-1 text-sm'>
                  <p className='font-bold text-amber-200'>No longer available</p>
                  <CustomShopLink
                    href={productHref}
                    className='inline-flex font-semibold text-blue-200 underline underline-offset-2'
                  >
                    Choose another available option
                  </CustomShopLink>
                </div>
              )}

              {isUnverified && (
                <p role='status' className='mt-2 text-sm font-semibold text-amber-200'>
                  Availability could not be verified. Please refresh before checkout.
                </p>
              )}

              {isChecking && (
                <p role='status' className='mt-2 text-sm text-white/70'>
                  Checking availability…
                </p>
              )}

              <h4 className='text-base text-white'>
                Price: <GlobalProductPrice usdAmount={retail_price} /> (each)
              </h4>
            </section>

            {/* Mobile: Size & Color under the image */}
            <section className='col-span-1 col-start-1 flex flex-col gap-1 md:hidden'>
              <SizeAndColorElem options={options as ProductVariantOptions} />
            </section>

            {/* Mobile: Quantity, Delete & Total on the right */}
            <div className='col-span-2 col-start-2 flex flex-col items-end gap-2 md:hidden'>
              <div className='flex items-center justify-end gap-2'>
                <ItemQuantityComponent
                  className='flex'
                  cartItem={cartItem}
                  disableIncrement={!canIncreaseQuantity}
                  onAvailabilityChange={onAvailabilityChange}
                />
                {renderRemoveButton(cartItem.variantId)}
              </div>
              <h3 className='text-[1.1rem] font-semibold text-right'>
                Total: <GlobalProductPrice usdAmount={lineTotal} />
              </h3>
            </div>

            {/* Tablet / Desktop: Size & Color with Quantity + Delete aligned on the right */}
            <section className='hidden md:flex md:flex-col md:items-center md:justify-around gap-2'>
              {/* Size & Color */}
              <SizeAndColorElem options={options as ProductVariantOptions} />

              {/* Quantity + Delete (desktop and up) */}
              <div className='flex items-center justify-end gap-2'>
                <ItemQuantityComponent
                  className='flex'
                  cartItem={cartItem}
                  disableIncrement={!canIncreaseQuantity}
                  onAvailabilityChange={onAvailabilityChange}
                />
                {renderRemoveButton(cartItem.variantId)}
              </div>
            </section>

            {/* Total (tablet & desktop) */}
            <div
              className='hidden md:flex flex-col justify-center items-end text-right
              col-span-2 md:col-span-4 xl:col-span-1 py-4 lg:py-0'
            >
              <span className='text-sm text-white/80 uppercase tracking-wide'>Line Total</span>
              <h3 className='text-[1.075rem] font-semibold'>
                <GlobalProductPrice usdAmount={lineTotal} />
              </h3>
            </div>
          </div>
        );
      })}

      {/* Remove confirmation dialog */}
      <AlertDialog
        open={pendingRemoveId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoveId(null);
        }}
      >
        <AlertDialogContent className='bg-black/70 backdrop-blur-xl backdrop-saturate-150 border border-white/10 text-white shadow-2xl shadow-black/70 rounded-2xl max-w-md w-[90vw]'>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove item?</AlertDialogTitle>
            <AlertDialogDescription className='text-gray-200'>
              This will remove the selected item from your cart. You can always add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className='border border-white/25 bg-transparent text-white/80 hover:bg-white/5 hover:text-white rounded-lg px-4'>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className='border border-red-400 bg-transparent text-red-400 hover:bg-red-500/15 hover:text-red-200 rounded-lg px-4 font-semibold'
              onClick={handleConfirmRemove}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default CartItems;
