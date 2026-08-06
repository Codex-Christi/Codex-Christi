// POST /api/paypal/authorize
import { randomUUID } from 'crypto';
import {
  OrdersController,
  type Order,
  type OrderAuthorizeResponse,
} from '@paypal/paypal-server-sdk';
import { getPayPalClient } from '@/lib/paymentClients/paypalClient';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { createPayPalRouteResponders } from '@/lib/paypal/txLedger/routeResponses';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import type { CanonicalPaymentReconciliationResult } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { notifyCanonicalPaymentFailure } from '@/lib/paypal/txLedger/canonicalPaymentFailureNotification';
import { shouldResyncExistingAuthorization } from '@/lib/paypal/txLedger/authorizationRecoveryPolicy';
import { hasProcessingAuthorizePayload } from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import { commitOptimisticLedgerTransition } from '@/lib/paypal/txLedger/optimisticLedgerTransition';
import {
  buildPayPalAuthorizationFailureLedgerTransition,
  buildPayPalAuthorizationLedgerTransition,
} from '@/lib/paypal/txLedger/payPalAuthorizationLedgerTransition';
import type { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';

const NON_AUTHORIZABLE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.COMPLETED,
  PAYPAL_LEDGER_STATUS.REFUNDED,
]);

function getAuthorizationId(payload?: {
  purchaseUnits?: Array<{
    payments?: {
      authorizations?: Array<{ id?: string | null }>;
    };
  }>;
}) {
  return payload?.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id ?? null;
}

async function persistAuthorizedResult(
  orderToken: string,
  payload: OrderAuthorizeResponse | Order,
) {
  const committed = await commitOptimisticLedgerTransition({
    load: () => paypalTxLedger.paypalIntent.findUnique({ where: { orderToken } }),
    build: (row) => buildPayPalAuthorizationLedgerTransition(row, payload),
    commit: async (row, transition) => {
      const updated = await paypalTxLedger.paypalIntent.updateMany({
        where: { orderToken, status: row.status, updatedAt: row.updatedAt },
        data: transition.data as Prisma.PaypalIntentUpdateManyMutationInput,
      });
      return updated.count === 1;
    },
  });
  await refreshPaidOrderRecoveryProjectionSafely(orderToken);
  if (committed.transition.reconciliationFailure) {
    await notifyCanonicalPaymentFailure(
      committed.row,
      committed.transition.reconciliationFailure,
    );
  }

  return committed.transition.reconciliation;
}

async function persistAuthorizationFailure(
  orderToken: string,
  failure: { code: string; message: string },
) {
  const committed = await commitOptimisticLedgerTransition({
    load: () => paypalTxLedger.paypalIntent.findUnique({ where: { orderToken } }),
    build: (row) => buildPayPalAuthorizationFailureLedgerTransition(row, failure),
    commit: async (row, transition) => {
      const updated = await paypalTxLedger.paypalIntent.updateMany({
        where: { orderToken, status: row.status, updatedAt: row.updatedAt },
        data: transition.data as Prisma.PaypalIntentUpdateManyMutationInput,
      });
      return updated.count === 1;
    },
  });
  await refreshPaidOrderRecoveryProjectionSafely(orderToken);
  if (committed.transition.reconciliationFailure) {
    await notifyCanonicalPaymentFailure(
      committed.row,
      committed.transition.reconciliationFailure,
    );
  }
}

async function syncExistingAuthorization(orderID: string, orderToken: string) {
  const orders = new OrdersController(getPayPalClient());
  const { result } = await orders.getOrder({ id: orderID });

  if (!getAuthorizationId(result)) return null;

  const reconciliation = await persistAuthorizedResult(orderToken, result);
  return { payload: result, reconciliation };
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  let orderToken: string | undefined;

  const { error: routeError } = createPayPalRouteResponders({
    requestId,
    getOrderToken: () => orderToken,
  });
  const validationError = (code: string, message: string, status = 400) =>
    routeError({
      status,
      code,
      stage: 'validate_request',
      message,
    });
  const reconciliationError = (result: CanonicalPaymentReconciliationResult) =>
    routeError({
      status: 409,
      code: result.errorCode ?? 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
      stage: 'reconcile_authorization_amount',
      message: result.reason,
    });
  const fail = async ({
    code,
    stage,
    message,
    err,
    status = 500,
    persistToLedger = true,
  }: {
    code: string;
    stage: string;
    message: string;
    err: unknown;
    status?: number;
    persistToLedger?: boolean;
  }) => {
    console.error(`[paypal.authorize.${stage}]`, {
      requestId,
      orderToken,
      code,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (persistToLedger && orderToken) {
      await persistAuthorizationFailure(orderToken, {
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return routeError({
      status,
      code,
      stage,
      message,
    });
  };

  try {
    const { orderToken: requestOrderToken, orderID } = await req.json();
    orderToken = requestOrderToken;

    if (!orderToken || !orderID) {
      return validationError('INVALID_AUTHORIZE_REQUEST', 'orderToken and orderID are required');
    }

    const intent = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
    });

    if (!intent) {
      return routeError({
        status: 404,
        code: 'INTENT_NOT_FOUND',
        stage: 'load_intent',
        message: 'Intent not found',
      });
    }

    if (!intent.paypalOrderId || intent.paypalOrderId !== orderID) {
      return routeError({
        status: 409,
        code: 'PAYPAL_ORDER_MISMATCH',
        stage: 'validate_intent',
        message: 'PayPal order mismatch',
      });
    }

    if (
      intent.status === PAYPAL_LEDGER_STATUS.AUTHORIZED &&
      hasProcessingAuthorizePayload(intent.authorizePayload)
    ) {
      const reconciliation = await persistAuthorizedResult(
        orderToken,
        intent.authorizePayload as unknown as Order,
      );
      if (!reconciliation.ok) return reconciliationError(reconciliation);

      return Response.json(intent.authorizePayload);
    }

    // PayPal may already be authorized because our write failed or because its verified webhook
    // won the race. Fetch the order-shaped provider payload instead of reauthorizing or rejecting
    // an AUTHORIZED row whose detailed evidence has not landed yet.
    if (shouldResyncExistingAuthorization(intent)) {
      try {
        const existingAuthorizedOrder = await syncExistingAuthorization(orderID, orderToken);
        if (existingAuthorizedOrder) {
          if (!existingAuthorizedOrder.reconciliation.ok) {
            return reconciliationError(existingAuthorizedOrder.reconciliation);
          }
          return Response.json(existingAuthorizedOrder.payload);
        }
        if (intent.status === PAYPAL_LEDGER_STATUS.AUTHORIZED) {
          return routeError({
            status: 409,
            code: 'AUTHORIZATION_EVIDENCE_PENDING',
            stage: 'resync_authorize_state',
            message: 'PayPal authorization is confirmed, but its order details are still syncing.',
          });
        }
      } catch (syncErr) {
        return fail({
          code: 'AUTHORIZE_RESYNC_FAILED',
          stage: 'resync_authorize_state',
          message: 'Failed to resync existing PayPal authorization state',
          err: syncErr,
          persistToLedger: false,
        });
      }
    }

    if (NON_AUTHORIZABLE_STATUSES.has(intent.status)) {
      return routeError({
        status: 409,
        code: 'AUTHORIZE_STATE_CONFLICT',
        stage: 'validate_intent',
        message: `Cannot authorize intent from status "${intent.status}"`,
      });
    }

    if (
      intent.status !== PAYPAL_LEDGER_STATUS.INTENT_CREATED &&
      intent.status !== PAYPAL_LEDGER_STATUS.ERROR
    ) {
      return routeError({
        status: 409,
        code: 'AUTHORIZE_STATE_INVALID',
        stage: 'validate_intent',
        message: `Unexpected intent status "${intent.status}" before authorize`,
      });
    }

    const orders = new OrdersController(getPayPalClient());
    const { result } = await orders.authorizeOrder({
      id: orderID,
      prefer: 'return=representation',
    });

    try {
      const reconciliation = await persistAuthorizedResult(orderToken, result);
      if (!reconciliation.ok) return reconciliationError(reconciliation);
    } catch (persistErr) {
      // Keep this distinct so retries know PayPal may already be ahead of the ledger.
      return fail({
        code: 'AUTHORIZE_PERSIST_FAILED',
        stage: 'persist_authorize_payload',
        message: 'PayPal authorization succeeded but ledger persistence failed',
        err: persistErr,
        persistToLedger: false,
      });
    }

    return Response.json(result);
  } catch (err: unknown) {
    return fail({
      code: 'AUTHORIZE_FAILED',
      stage: 'authorize_order',
      message: 'Failed to authorize PayPal order',
      err,
    });
  }
}
