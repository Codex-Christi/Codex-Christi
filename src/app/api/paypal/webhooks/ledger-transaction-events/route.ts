import { after } from 'next/server';

import { getPayPalWebhookProcessingOwner } from '@/lib/paypal/ledgerWebhookConfig';
import { resolvePayPalLedgerTrustedWebhookIds } from '@/lib/paypal/ledgerWebhookTrust';
import type { PayPalLedgerTrustedWebhookCandidate } from '@/lib/paypal/ledgerWebhookTrust';
import { getServerPayPalConfig } from '@/lib/paypal/serverPayPalConfig';
import { runPaidFulfillmentProcessing } from '@/lib/paypal/txLedger/runPaidFulfillmentProcessing';
import {
  ensureWebhookDeliveryRecord,
  getWebhookLedgerCorrelation,
  markWebhookFailed,
  markWebhookIgnored,
  markWebhookProcessed,
  markWebhookRetry,
  requiredHeader,
  type PayPalWebhookEvent,
  verifyWebhookSignature,
} from '@/lib/paypal/txLedger/webhookHelpers';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import { notifyCanonicalPaymentFailure } from '@/lib/paypal/txLedger/canonicalPaymentFailureNotification';
import { commitOptimisticLedgerTransition } from '@/lib/paypal/txLedger/optimisticLedgerTransition';
import { buildPayPalWebhookLedgerTransition } from '@/lib/paypal/txLedger/payPalWebhookLedgerTransition';
import type { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PayPalWebhookVerificationHeaders = {
  paypalAuthAlgo: string;
  paypalCertUrl: string;
  paypalTransmissionId: string;
  paypalTransmissionSig: string;
  paypalTransmissionTime: string;
};

type WebhookProcessingOwnershipDecision =
  | { shouldProcess: true; reason: null }
  | { shouldProcess: false; reason: string };

function shouldVerifyWebhookSignature() {
  const configured = (process.env.PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION ?? '').toLowerCase();

  if (configured === 'required') return true;
  if (configured === 'disabled') return false;

  throw new Error(
    'Invalid PAYPAL_WEBHOOK_SIGNATURE_VERIFICATION. Expected "required" or "disabled".',
  );
}

async function verifyWebhookSignatureWithAnyConfiguredWebhookId({
  candidates,
  event,
  headers,
}: {
  candidates: PayPalLedgerTrustedWebhookCandidate[];
  event: PayPalWebhookEvent;
  headers: PayPalWebhookVerificationHeaders;
}) {
  for (const candidate of candidates) {
    try {
      const ok = await verifyWebhookSignature({
        event,
        webhookId: candidate.webhookId,
        ...headers,
      });

      if (ok) return candidate;
    } catch (error) {
      console.warn('[PayPal Webhook] signature verification failed for configured webhook ID', {
        webhookId: candidate.webhookId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

function getWebhookProcessingOwnershipDecision({
  matchedWebhook,
  owner,
  ownerError,
  shouldVerify,
}: {
  matchedWebhook: PayPalLedgerTrustedWebhookCandidate | null;
  owner: string;
  ownerError: string | null;
  shouldVerify: boolean;
}): WebhookProcessingOwnershipDecision {
  if (ownerError) {
    return {
      shouldProcess: false,
      reason: ownerError,
    };
  }

  if (owner === 'none') {
    return {
      shouldProcess: false,
      reason: 'PayPal webhook processing owner is set to none.',
    };
  }

  if (!shouldVerify) {
    return { shouldProcess: true, reason: null };
  }

  if (matchedWebhook?.bindingKey === owner) {
    return { shouldProcess: true, reason: null };
  }

  return {
    shouldProcess: false,
    reason: matchedWebhook?.bindingKey
      ? `Webhook matched ${matchedWebhook.bindingKey}, but ${owner} owns processing for this runtime.`
      : `Webhook matched an additional/unnamed webhook ID, but ${owner} owns processing for this runtime.`,
  };
}

async function updateLedgerFromWebhook(args: {
  orderToken: string;
  eventType: string;
  webhookResource: unknown;
}): Promise<{ shouldScheduleFulfillment: boolean }> {
  const committed = await commitOptimisticLedgerTransition({
    load: () => paypalTxLedger.paypalIntent.findUnique({ where: { orderToken: args.orderToken } }),
    build: (row) =>
      buildPayPalWebhookLedgerTransition(row, args.eventType, args.webhookResource),
    commit: async (row, transition) => {
      if (!transition.data) return true;
      const updated = await paypalTxLedger.paypalIntent.updateMany({
        where: {
          orderToken: args.orderToken,
          status: row.status,
          updatedAt: row.updatedAt,
        },
        data: transition.data as Prisma.PaypalIntentUpdateManyMutationInput,
      });
      return updated.count === 1;
    },
  });

  if (committed.transition.reconciliationFailure) {
    await notifyCanonicalPaymentFailure(
      committed.row,
      committed.transition.reconciliationFailure,
    );
  }

  return {
    shouldScheduleFulfillment: committed.transition.shouldScheduleFulfillment,
  };
}

export async function POST(req: Request) {
  let eventId: string | undefined;

  try {
    const config = getServerPayPalConfig();
    const trustResolution = await resolvePayPalLedgerTrustedWebhookIds(config.paymentMode);
    const processingOwnership = getPayPalWebhookProcessingOwner(config.paymentMode);
    const shouldVerify = shouldVerifyWebhookSignature();
    let matchedWebhook: PayPalLedgerTrustedWebhookCandidate | null = null;

    const raw = await req.text();
    const event = JSON.parse(raw) as PayPalWebhookEvent;
    eventId = event.id;

    if (shouldVerify) {
      if (!trustResolution.webhookIds.length) {
        throw new Error('Missing PayPal webhook ID(s) for the selected payment mode.');
      }

      matchedWebhook = await verifyWebhookSignatureWithAnyConfiguredWebhookId({
        candidates: trustResolution.candidates,
        event,
        headers: {
          paypalAuthAlgo: requiredHeader(req, 'paypal-auth-algo'),
          paypalCertUrl: requiredHeader(req, 'paypal-cert-url'),
          paypalTransmissionId: requiredHeader(req, 'paypal-transmission-id'),
          paypalTransmissionSig: requiredHeader(req, 'paypal-transmission-sig'),
          paypalTransmissionTime: requiredHeader(req, 'paypal-transmission-time'),
        },
      });

      if (!matchedWebhook) {
        return new Response('Invalid signature', { status: 400 });
      }
    } else {
      console.warn('[PayPal Webhook] Signature verification skipped (dev/simulator mode).');
    }

    if (!event.id || !event.event_type) {
      return new Response('Missing event metadata', { status: 400 });
    }

    const ownershipDecision = getWebhookProcessingOwnershipDecision({
      matchedWebhook,
      owner: processingOwnership.owner,
      ownerError: processingOwnership.error,
      shouldVerify,
    });

    if (!ownershipDecision.shouldProcess) {
      console.info('[PayPal Webhook] acknowledged by non-owner runtime', {
        eventId: event.id,
        eventType: event.event_type,
        matchedWebhookBindingKey: matchedWebhook?.bindingKey ?? null,
        matchedWebhookLabel: matchedWebhook?.label ?? null,
        matchedWebhookSource:
          matchedWebhook?.source ?? (shouldVerify ? trustResolution.source : null),
        owner: processingOwnership.owner,
        ownerSource: processingOwnership.source,
        ownerEnvVarName: processingOwnership.envVarName,
        reason: ownershipDecision.reason,
      });

      return new Response('OK', { status: 200 });
    }

    const correlation = getWebhookLedgerCorrelation(event);

    const delivery = await ensureWebhookDeliveryRecord({
      eventId: event.id,
      eventType: event.event_type,
      matchedWebhookBindingKey: matchedWebhook?.bindingKey,
      matchedWebhookId: matchedWebhook?.webhookId,
      matchedWebhookLabel: matchedWebhook?.label,
      matchedWebhookSource:
        matchedWebhook?.source ?? (shouldVerify ? trustResolution.source : null),
      orderToken: correlation?.source === 'order_token' ? correlation.orderToken : undefined,
      paypalOrderId:
        correlation?.source === 'paypal_order_id' ? correlation.paypalOrderId : undefined,
      payload: event,
      webhookVerificationMode: shouldVerify ? 'required' : 'disabled',
    });

    if (delivery.processedAt) {
      return new Response('OK', { status: 200 });
    }

    if (!correlation) {
      await markWebhookIgnored(
        event.id,
        'No correlatable PayPal order ID or order token in webhook payload',
      );
      return new Response('OK', { status: 200 });
    }

    const row = await paypalTxLedger.paypalIntent.findUnique({
      where:
        correlation.source === 'paypal_order_id'
          ? { paypalOrderId: correlation.paypalOrderId }
          : { orderToken: correlation.orderToken },
    });

    // Ask PayPal to retry if the webhook beats ledger correlation.
    if (!row) {
      await markWebhookRetry(event.id, 'Ledger row not correlated yet');
      return new Response('Retry later', { status: 500 });
    }

    const ledgerUpdate = await updateLedgerFromWebhook({
      orderToken: row.orderToken,
      eventType: event.event_type,
      webhookResource: event.resource,
    });
    await refreshPaidOrderRecoveryProjectionSafely(row.orderToken);

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!ledgerUpdate.shouldScheduleFulfillment) {
        await markWebhookProcessed(event.id);
        return new Response('OK', { status: 200 });
      }

      // ACK fast so provider retries are driven by our DB state, not route latency.
      after(async () => {
        try {
          await runPaidFulfillmentProcessing(row.orderToken, {
            triggerDetail: matchedWebhook?.label ?? event.id,
            triggerSource: 'webhook',
          });
          await markWebhookProcessed(event.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          await markWebhookFailed(event.id, message);
          console.error('[PayPal Webhook] post-processing failed', {
            eventId: event.id,
            orderToken: row.orderToken,
            error: message,
          });
        }
      });

      return new Response('OK', { status: 200 });
    }

    await markWebhookProcessed(event.id);

    return new Response('OK', { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (eventId) {
      try {
        await markWebhookFailed(eventId, message);
      } catch {
        // Do not hide the original webhook failure if the event record update also fails.
      }
    }

    console.error('[PayPal Webhook] handler failed', {
      eventId,
      error: message,
    });

    return new Response('Webhook error', { status: 500 });
  }
}
