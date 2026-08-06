'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createCheckoutObfuscatedStorage } from './storage';

interface DjangoOrderIntentState {
  djangoOrderIntentUuid: string;
  djangoOrderIntentOrderId: string;
  djangoOrderIntentPayload: unknown | null;
  djangoOrderIntentVerifyPayload: unknown | null;
  djangoOrderIntentVerifiedAt: string | null;
  setDjangoOrderIntent: (intent: {
    djangoOrderIntentUuid?: string | null;
    djangoOrderIntentOrderId?: string | null;
    djangoOrderIntentPayload?: unknown | null;
    djangoOrderIntentVerifyPayload?: unknown | null;
    djangoOrderIntentVerifiedAt?: string | null;
  }) => void;
  clearDjangoOrderIntent: () => void;
}

const initialState = {
  djangoOrderIntentUuid: '',
  djangoOrderIntentOrderId: '',
  djangoOrderIntentPayload: null,
  djangoOrderIntentVerifyPayload: null,
  djangoOrderIntentVerifiedAt: null,
};

export const useDjangoOrderIntentStore = create<DjangoOrderIntentState>()(
  persist(
    (set) => ({
      ...initialState,
      setDjangoOrderIntent: (intent) =>
        set((state) => ({
          djangoOrderIntentUuid: intent.djangoOrderIntentUuid ?? state.djangoOrderIntentUuid,
          djangoOrderIntentOrderId:
            intent.djangoOrderIntentOrderId ?? state.djangoOrderIntentOrderId,
          djangoOrderIntentPayload:
            intent.djangoOrderIntentPayload === undefined
              ? state.djangoOrderIntentPayload
              : intent.djangoOrderIntentPayload,
          djangoOrderIntentVerifyPayload:
            intent.djangoOrderIntentVerifyPayload === undefined
              ? state.djangoOrderIntentVerifyPayload
              : intent.djangoOrderIntentVerifyPayload,
          djangoOrderIntentVerifiedAt:
            intent.djangoOrderIntentVerifiedAt === undefined
              ? state.djangoOrderIntentVerifiedAt
              : intent.djangoOrderIntentVerifiedAt,
        })),
      clearDjangoOrderIntent: () => set({ ...initialState }),
    }),
    {
      name: 'django-order-intent-store',
      storage: createCheckoutObfuscatedStorage<DjangoOrderIntentState>('django-order-intent-store'),
      skipHydration: typeof window === 'undefined',
    },
  ),
);
