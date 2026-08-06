'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createCheckoutObfuscatedStorage } from './storage';

export type ActivePayPalCheckoutStage =
  | 'paypal_order_created'
  | 'paypal_window_opened'
  | 'paypal_cancelled'
  | 'paypal_approved'
  | 'capture_checking'
  | 'confirmation_opened';

export type ActivePayPalCheckoutPaymentSurface = 'paypal_buttons' | 'card';

export type ActivePayPalCheckout = {
  orderToken: string;
  stage: ActivePayPalCheckoutStage;
  paymentSurface?: ActivePayPalCheckoutPaymentSurface | null;
  createdAt: string;
  updatedAt: string;
};

type PayPalIntentState = {
  orderToken?: string;
  activeCheckout: ActivePayPalCheckout | null;
  setIntent: (payload: {
    orderToken: string;
    stage?: ActivePayPalCheckoutStage;
    paymentSurface?: ActivePayPalCheckoutPaymentSurface | null;
  }) => void;
  setActiveCheckoutStage: (
    stage: ActivePayPalCheckoutStage,
    payload?: {
      orderToken?: string;
      paymentSurface?: ActivePayPalCheckoutPaymentSurface | null;
    },
  ) => void;
  clearActiveCheckout: () => void;
  clearIntent: () => void;
};
type PayPalIntentPersistedState = Pick<PayPalIntentState, 'orderToken' | 'activeCheckout'>;

function createActiveCheckout({
  orderToken,
  stage = 'paypal_order_created',
  paymentSurface = null,
}: {
  orderToken: string;
  stage?: ActivePayPalCheckoutStage;
  paymentSurface?: ActivePayPalCheckoutPaymentSurface | null;
}): ActivePayPalCheckout {
  const now = new Date().toISOString();

  return {
    orderToken,
    stage,
    paymentSurface,
    createdAt: now,
    updatedAt: now,
  };
}

export const usePayPalIntentStore = create<PayPalIntentState>()(
  persist(
    (set) => ({
      orderToken: undefined,
      activeCheckout: null,
      setIntent: ({ orderToken, stage, paymentSurface }) =>
        set({
          orderToken,
          activeCheckout: createActiveCheckout({ orderToken, stage, paymentSurface }),
        }),
      setActiveCheckoutStage: (stage, payload) =>
        set((state) => {
          const activeCheckout =
            state.activeCheckout ??
            (payload?.orderToken
              ? createActiveCheckout({
                  orderToken: payload.orderToken,
                  stage,
                  paymentSurface: payload.paymentSurface,
                })
              : null);

          if (!activeCheckout) return state;

          return {
            orderToken: payload?.orderToken ?? state.orderToken ?? activeCheckout.orderToken,
            activeCheckout: {
              ...activeCheckout,
              orderToken: payload?.orderToken ?? activeCheckout.orderToken,
              stage,
              paymentSurface: payload?.paymentSurface ?? activeCheckout.paymentSurface ?? null,
              updatedAt: new Date().toISOString(),
            },
          };
        }),
      clearActiveCheckout: () => set({ activeCheckout: null }),
      clearIntent: () => set({ orderToken: undefined }),
    }),
    {
      name: 'paypal-intent-store',
      storage: createCheckoutObfuscatedStorage<PayPalIntentPersistedState>('paypal-intent-store'),
      partialize: (state): PayPalIntentPersistedState => ({
        orderToken: state.orderToken,
        activeCheckout: state.activeCheckout,
      }),
      skipHydration: typeof window === 'undefined',
    },
  ),
);
