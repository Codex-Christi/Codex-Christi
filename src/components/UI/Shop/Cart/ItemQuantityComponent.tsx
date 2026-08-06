import { CartVariant, useCartStore } from '@/stores/shop_stores/cartStore';
import { FC, ReactNode, useCallback, useState } from 'react';
import { Button, ButtonProps } from '../../primitives/button';
import { validateCartItemForQuantityIncrease } from '@/actions/shop/cart/hydrateCartDisplayFromMerchizeOfflineCatalog';
import type { CartItemAvailabilityStatus } from './cartAvailability';

export const ItemQuantityComponent: FC<{
  cartItem: CartVariant;
  className?: string;
  disableIncrement?: boolean;
  onAvailabilityChange?: (variantId: string, status: CartItemAvailabilityStatus) => void;
}> = ({ cartItem, className, disableIncrement = false, onAvailabilityChange }) => {
  const { quantity, title, variantId } = cartItem;

  //   Hooks
  const { addToCart, reduceFromCart } = useCartStore();
  const [isCheckingIncrement, setIsCheckingIncrement] = useState(false);

  //   Handlers
  const incrementItemQuantity = useCallback(async () => {
    if (disableIncrement || isCheckingIncrement) return;

    setIsCheckingIncrement(true);
    try {
      const availability = await validateCartItemForQuantityIncrease(cartItem);
      onAvailabilityChange?.(variantId, availability.status);
      if (availability.status !== 'available') return;

      addToCart({ ...cartItem, quantity: 1 });
    } catch (error) {
      console.warn('[ItemQuantityComponent] Availability check failed:', error);
      onAvailabilityChange?.(variantId, 'unverified');
    } finally {
      setIsCheckingIncrement(false);
    }
  }, [addToCart, cartItem, disableIncrement, isCheckingIncrement, onAvailabilityChange, variantId]);

  const decrementQuantity = useCallback(() => {
    reduceFromCart(variantId, 1);
  }, [reduceFromCart, variantId]);
  //

  // JSX
  return (
    <section
      className={`flex-row items-center border-gray-300 border-[.5px]
         rounded-lg ${className} justify-between w-full min-w-[6.5rem] not-a`}
    >
      {/* Reduce quantity */}
      <OperationButton name={`Remove ${title} ${variantId} from Cart`} onClick={decrementQuantity}>
        -
      </OperationButton>
      {/* Quantity digit */}
      <h4 className={`text-[1.05rem] font-bold`}>{`${quantity}`}</h4>

      {/* Increment quantity */}
      <OperationButton
        name={`Add ${title} ${variantId} to Cart`}
        disabled={disableIncrement || isCheckingIncrement}
        aria-disabled={disableIncrement || isCheckingIncrement}
        className={disableIncrement || isCheckingIncrement ? '!cursor-not-allowed' : undefined}
        onClick={incrementItemQuantity}
      >
        +
      </OperationButton>
    </section>
  );
};

interface OperationButtonInterface extends ButtonProps {
  onClick?: () => void;
  name: string;
  children: ReactNode;
}

const OperationButton: FC<OperationButtonInterface> = ({
  className,
  name,
  onClick,
  children,
  ...rest
}) => {
  return (
    <Button
      className={`bg-slate-950 !rounded-lg text-2xl p-3 ${className ?? ''}`}
      name={`${name}`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </Button>
  );
};
