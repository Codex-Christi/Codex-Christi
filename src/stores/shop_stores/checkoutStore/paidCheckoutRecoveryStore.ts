'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createCheckoutObfuscatedStorage } from './storage';

const PAID_CHECKOUT_RECOVERY_SESSION_TTL_MS = 15 * 60 * 1000;

export type PaidCheckoutRecoverySummary = {
  orderToken: string;
  status: string;
  receiptLink: string | null;
  receiptFile: string | null;
  djangoPaymentSaveCustomId: string | null;
  supportReference: string;
  shortSupportReference: string;
  createdAt: string;
  updatedAt: string;
  placedAtLabel: string;
  paidAmountLabel: string | null;
  itemCount: number;
  itemSummaryLabel: string | null;
  itemTitles: string[];
  shippingSummaryLabel: string | null;
  statusLabel: string;
  message: string;
};

type PaidCheckoutRecoverySession = {
  email: string;
  checkouts: PaidCheckoutRecoverySummary[];
  verifiedAt: string;
  expiresAt: string;
};

type PaidCheckoutRecoveryStore = {
  recoverySession: PaidCheckoutRecoverySession | null;
  setVerifiedRecoverySession: (payload: {
    email: string;
    checkouts: PaidCheckoutRecoverySummary[];
  }) => void;
  clearRecoverySession: () => void;
};

function normalizeRecoverySessionEmail(email: string) {
  return email.trim().toLowerCase();
}

function isFreshRecoverySession(session: PaidCheckoutRecoverySession | null) {
  if (!session) return false;

  const expiresAt = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export const usePaidCheckoutRecoveryStore = create<PaidCheckoutRecoveryStore>()(
  persist(
    (set) => ({
      recoverySession: null,
      setVerifiedRecoverySession: ({ email, checkouts }) => {
        const now = Date.now();

        set({
          recoverySession: {
            email: normalizeRecoverySessionEmail(email),
            checkouts,
            verifiedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + PAID_CHECKOUT_RECOVERY_SESSION_TTL_MS).toISOString(),
          },
        });
      },
      clearRecoverySession: () => set({ recoverySession: null }),
    }),
    {
      name: 'paid-checkout-recovery-store',
      storage: createCheckoutObfuscatedStorage<PaidCheckoutRecoveryStore>(
        'paid-checkout-recovery-store',
      ),
      skipHydration: typeof window === 'undefined',
    },
  ),
);

export function getFreshPaidCheckoutRecoverySessionForEmail(email: string) {
  const normalizedEmail = normalizeRecoverySessionEmail(email);
  const { recoverySession, clearRecoverySession } = usePaidCheckoutRecoveryStore.getState();
  const session = recoverySession;

  if (!session || !isFreshRecoverySession(session)) {
    if (session) clearRecoverySession();
    return null;
  }

  if (session.email !== normalizedEmail) return null;

  return session;
}

export function getPaidCheckoutRecoverySessionRemainingMinutes(
  session: PaidCheckoutRecoverySession,
) {
  return Math.max(1, Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 60_000));
}
