import errorToast from '@/lib/error-toast';
import MyPaypalButtons from './MyPaypalButtons';
import MyPayPalCardFields from './MyPaypalCardFields';
import { FC, useCallback } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { CheckoutOptions } from '../PaymentSection';
import { useCartStore } from '@/stores/shop_stores/cartStore';
import { useShopCheckoutStore } from '@/stores/shop_stores/checkoutStore';
import { usePayPalTXApproveCallback } from '@/lib/hooks/shopHooks/checkout/usePayPalTXApproveCallback';
import { usePayPalIntentStore } from '@/stores/shop_stores/checkoutStore/paypalIntentStore';
import { useDjangoOrderIntentStore } from '@/stores/shop_stores/checkoutStore/djangoOrderIntentStore';
import successToast from '@/lib/success-toast';

const PayPalCheckoutChildren: FC<{ mode: CheckoutOptions }> = (props) => {
  // Props
  const { mode } = props;

  // Hooks
  const cart = useCartStore((store) => store.variants);
  const { first_name, last_name, email, delivery_address } = useShopCheckoutStore();
  const { isFinalizingPayment, mainPayPalApproveCallback } = usePayPalTXApproveCallback();
  const setIntent = usePayPalIntentStore((store) => store.setIntent);
  const setActiveCheckoutStage = usePayPalIntentStore((store) => store.setActiveCheckoutStage);
  const {
    djangoOrderIntentUuid,
    djangoOrderIntentOrderId,
    djangoOrderIntentPayload,
    djangoOrderIntentVerifyPayload,
  } = useDjangoOrderIntentStore();

  // Create order async function
  const createOrder = useCallback(async (): Promise<string> => {
    type IntentResponse =
      | {
          data: {
            orderToken: string;
            paypalOrderId: string;
          };
          requestId: string;
        }
      | {
          error: {
            code: string;
            stage: string;
            message: string;
            requestId: string;
            orderToken?: string;
          };
    };

    try {
      const response = await fetch('/next-api/paypal/tx-ledger/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Product/variant IDs are selectors only. The server resolves every descriptive and
          // monetary field again before creating the PayPal order.
          selections: cart.map((item) => ({
            productId: item.itemDetail.product,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          customer: {
            name: `${first_name} ${last_name}`,
            email: email ?? '',
          },
          delivery_address,
          djangoOrderIntentUuid,
          djangoOrderIntentOrderId,
          djangoOrderIntentPayload,
          djangoOrderIntentVerifyPayload,
        }),
      });

      const payload = (await response.json()) as IntentResponse;

      if (!response.ok || !('data' in payload)) {
        const routeError =
          'error' in payload
            ? payload.error
            : {
                code: 'UNKNOWN_INTENT_ERROR',
                stage: 'intent_response',
                message: 'Failed to create PayPal intent',
                requestId: 'unknown_request_id',
              };

        const error = new Error(routeError.message ?? 'Failed to create PayPal intent');
        error.name =
          routeError.stage === 'resolve_canonical_order_snapshot'
            ? 'CanonicalOrderResolutionError'
            : 'PayPalIntentError';
        throw error;
      }

      setIntent({
        orderToken: payload.data.orderToken,
        stage: mode === 'paypal_buttons' ? 'paypal_window_opened' : 'paypal_order_created',
        paymentSurface: mode === 'card' ? 'card' : 'paypal_buttons',
      });

      return payload.data.paypalOrderId;
    } catch (err: unknown) {
      const isOrderResolutionUnavailable =
        err instanceof Error && err.name === 'CanonicalOrderResolutionError';

      errorToast({
        header: isOrderResolutionUnavailable
          ? 'Checkout temporarily unavailable'
          : 'Payment setup failed',
        message: err instanceof Error ? err.message : String(err),
      });
      throw new Error('Failed to create PayPal order');
    }
  }, [
    cart,
    delivery_address,
    email,
    first_name,
    last_name,
    djangoOrderIntentUuid,
    djangoOrderIntentOrderId,
    djangoOrderIntentPayload,
    djangoOrderIntentVerifyPayload,
    mode,
    setIntent,
  ]);

  // Main JSX
  const handlePayPalCancel = useCallback(() => {
    setActiveCheckoutStage('paypal_cancelled');
    successToast({
      header: 'Payment not completed',
      message: 'You have not been charged. You can safely try again.',
    });
  }, [setActiveCheckoutStage]);

  return (
    <div className='w-full mx-auto'>
      {isFinalizingPayment ? <PayPalFinalizingOverlay /> : null}

      <MyPaypalButtons
        mode={mode}
        createOrder={createOrder}
        onApprove={mainPayPalApproveCallback}
        onCancel={handlePayPalCancel}
      />

      <MyPayPalCardFields
        mode={mode}
        createOrder={createOrder}
        onApprove={mainPayPalApproveCallback}
      />
    </div>
  );
};

function PayPalFinalizingOverlay() {
  return (
    <div className='fixed inset-0 z-[80] flex items-center justify-center bg-black/55 px-4 backdrop-blur-md'>
      <div className='w-full max-w-sm overflow-hidden rounded-3xl border border-cyan-100/20 bg-slate-950/80 p-5 text-center text-white shadow-[0_28px_80px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]'>
        <div className='mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-cyan-100/25 bg-cyan-100/[0.08]'>
          <Loader2 className='h-6 w-6 animate-spin text-cyan-100' />
        </div>
        <div className='mt-4 flex items-center justify-center gap-2 text-sm font-semibold text-cyan-50'>
          <ShieldCheck size={16} />
          Finalizing payment
        </div>
        <p className='mt-2 text-sm leading-5 text-white/68'>
          PayPal approved your payment. We are securely confirming it now.
        </p>
      </div>
    </div>
  );
}

export default PayPalCheckoutChildren;
