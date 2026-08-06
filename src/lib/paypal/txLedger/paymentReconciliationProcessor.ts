import 'server-only';

import { OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';
import { getPayPalClient } from '@/lib/paymentClients/paypalClient';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import {
  getNestedCapture,
  getRelatedAuthorizationId,
  getRelatedCaptureId,
  getRelatedOrderId,
} from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import {
  handleMissingPaymentReference,
  handleReconciledAuthorization,
  handleReconciledCapture,
} from '@/lib/paypal/txLedger/paymentReconciliationStateHandlers';
import type {
  PaymentLedgerRow,
  PayPalPaymentReconciliationResult,
} from '@/lib/paypal/txLedger/paymentReconciliationTypes';

async function getPayPalOrderPayload({
  orders,
  orderId,
  required,
  orderToken,
}: {
  orders: OrdersController;
  orderId: string | null | undefined;
  required?: boolean;
  orderToken: string;
}) {
  if (!orderId) return undefined;

  try {
    return (await orders.getOrder({ id: orderId })).result;
  } catch (error) {
    if (required) throw error;

    console.warn('[paypal.payment_reconciliation.order_lookup_failed]', {
      orderToken,
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function reconcilePaymentRow(
  row: PaymentLedgerRow,
): Promise<PayPalPaymentReconciliationResult> {
  const paymentClient = getPayPalClient();
  const payments = new PaymentsController(paymentClient);
  const orders = new OrdersController(paymentClient);
  const localCaptureCompletion = getPayPalCaptureCompletion(row.capturePayload);

  if (localCaptureCompletion.captureId) {
    const { result } = await payments.getCapturedPayment({
      captureId: localCaptureCompletion.captureId,
    });
    const orderId = row.paypalOrderId ?? getRelatedOrderId(result);
    const orderPayload = await getPayPalOrderPayload({
      orders,
      orderId,
      orderToken: row.orderToken,
    });

    return handleReconciledCapture({ row, payload: result, orderPayload });
  }

  const knownOrderId =
    row.paypalOrderId ??
    getRelatedOrderId(row.capturePayload) ??
    getRelatedOrderId(row.authorizePayload);
  let orderPayload: unknown;

  if (knownOrderId) {
    orderPayload = await getPayPalOrderPayload({
      orders,
      orderId: knownOrderId,
      orderToken: row.orderToken,
      required: !row.paypalAuthorizationId,
    });

    const orderCapture = getNestedCapture(orderPayload);

    if (orderCapture) {
      return handleReconciledCapture({
        row: { ...row, paypalOrderId: knownOrderId },
        payload: orderCapture,
        orderPayload,
      });
    }

    const authorizationId = getRelatedAuthorizationId(orderPayload);

    if (authorizationId) {
      const { result: authorization } = await payments.getAuthorizedPayment({ authorizationId });
      return handleReconciledAuthorization({
        row: {
          ...row,
          paypalOrderId: knownOrderId,
          paypalAuthorizationId: authorizationId,
        },
        payload: authorization,
        orderPayload,
      });
    }
  }

  if (!row.paypalAuthorizationId) {
    return handleMissingPaymentReference(row);
  }

  const { result } = await payments.getAuthorizedPayment({
    authorizationId: row.paypalAuthorizationId,
  });
  const captureId = getRelatedCaptureId(result);

  if (captureId) {
    const { result: capture } = await payments.getCapturedPayment({ captureId });
    const orderId = row.paypalOrderId ?? getRelatedOrderId(capture) ?? getRelatedOrderId(result);
    const captureOrderPayload =
      orderPayload ??
      (await getPayPalOrderPayload({
        orders,
        orderId,
        orderToken: row.orderToken,
      }));

    return handleReconciledCapture({
      row: { ...row, paypalOrderId: orderId ?? row.paypalOrderId },
      payload: capture,
      orderPayload: captureOrderPayload,
      authorizationPayload: result,
    });
  }

  const orderId = row.paypalOrderId ?? getRelatedOrderId(result);
  const authorizationOrderPayload =
    orderPayload ??
    (await getPayPalOrderPayload({
      orders,
      orderId,
      orderToken: row.orderToken,
    }));
  const authorizationOrderCapture = getNestedCapture(authorizationOrderPayload);

  if (authorizationOrderCapture) {
    return handleReconciledCapture({
      row: { ...row, paypalOrderId: orderId ?? row.paypalOrderId },
      payload: authorizationOrderCapture,
      orderPayload: authorizationOrderPayload,
      authorizationPayload: result,
    });
  }

  return handleReconciledAuthorization({
    row: { ...row, paypalOrderId: orderId ?? row.paypalOrderId },
    payload: result,
    orderPayload: authorizationOrderPayload,
  });
}
