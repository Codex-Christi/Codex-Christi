import 'server-only';

import { randomUUID } from 'crypto';

import {
  savePaymentDataToBackend,
  type PaymentSavingActionProps,
} from '@/actions/shop/paypal/processAndUploadCompletedTx/savePaymentDataToBackend';
import {
  savePaymentReceiptToCloud,
  type PaymentReceiptProps,
} from '@/actions/shop/paypal/processAndUploadCompletedTx/savePaymentReceiptToCloud';
import {
  FulfillmentPayloadValidationError,
  FulfillmentProviderRejectedError,
  sendMerchizeFulfillmentOrder,
} from '@/lib/paypal/txLedger/sendMerchizeFulfillmentOrder';
import { registerAcceptedMerchizeFulfillmentProcess } from '@/lib/merchizeFulfillmentOps/registerAcceptedMerchizeFulfillmentProcess';
import {
  recordMerchizeFulfillmentPushDisabledByConfig,
  MerchizeFulfillmentPushError,
  pushMerchizeFulfillmentOrderToProduction,
} from '@/lib/merchizeFulfillmentOps/pushMerchizeFulfillmentOrderToProduction';
import { isMerchizeFulfillmentPushEnabled } from '@/lib/merchizeFulfillmentOps/pushPolicy';
import { CODEX_CHRISTI_FULFILLMENT_IDENTIFIER } from '@/lib/merchizeFulfillmentOps/fulfillmentIdentifier';
import { syncMerchizeFulfillmentOrder } from '@/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOrder';
import {
  isMerchizeLookupPendingProviderProcessingError,
  MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING_ERROR_CODE,
} from '@/lib/merchizeFulfillmentOps/lookupPending';
import { syncMerchizeFulfillmentOperationalSnapshots } from '@/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOperationalSnapshots';
import { runMerchizeProductionReadinessChecks } from '@/lib/merchizeFulfillmentOps/runMerchizeProductionReadinessChecks';
import { verifyMerchizeFulfillmentPush } from '@/lib/merchizeFulfillmentOps/verifyMerchizeFulfillmentPush';
import { extractMerchizeExternalOrderNumberFromDjangoProcessResponse } from '@/lib/merchizeFulfillmentOps/merchizeMapper';
import { getMerchizeBuyerAddressExpectationFromLedger } from '@/lib/merchizeFulfillmentOps/addressCorrectionVerification';
import {
  enqueueAdminFulfillmentPushVerifiedNotification,
  enqueueAdminRecoveryNotification,
  ADMIN_NOTIFICATION_SEVERITY,
  sendPendingAdminRecoveryNotificationsForOrder,
} from '@/lib/paypal/txLedger/adminNotificationOutbox';
import {
  enqueueCustomerFulfillmentPushVerifiedNotification,
  sendPendingCustomerNotificationsForOrder,
} from '@/lib/paypal/txLedger/customerNotificationOutbox';
import { isAcceptedDjangoFulfillmentProcessResponse } from '@/lib/paypal/txLedger/fulfillmentProcessResponse';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import { getMerchizeFulfillmentRetryEligibility } from '@/lib/paypal/txLedger/fulfillmentRetryPolicy';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { assertShopOpsMutationAllowed } from '@/lib/prisma/shop/shopOpsDataTarget';
import { encryptForPostProcessingServerAction } from '@/lib/utils/shop/checkout/serverPostProcessingCrypto';
import type { CartVariant } from '@/stores/shop_stores/cartStore';

const POST_PROCESSING_LEASE_MS = 5 * 60_000;

type RunPaidFulfillmentProcessingOptions = {
  overrideMerchizeFulfillmentPushDisabled?: boolean;
  allowStaleMerchizeOrderManualRelease?: boolean;
  executionScope?: 'full_post_payment' | 'merchize_fulfillment_only';
  localProductionMasterConfirmed?: boolean;
  triggerDetail?: string;
  triggerSource?:
    'capture_route' | 'manual_admin' | 'payment_reconciliation' | 'recovery_scanner' | 'webhook';
};

export type PaidFulfillmentProcessingStage =
  | 'capture_validation'
  | 'completion'
  | 'django_fulfillment_handoff'
  | 'django_payment_save'
  | 'ledger_validation'
  | 'merchize_order_registration'
  | 'merchize_order_sync'
  | 'merchize_production_push'
  | 'merchize_push_verification'
  | 'merchize_readiness'
  | 'receipt_generation';

const PROCESSING_STAGE_DETAILS: Record<
  PaidFulfillmentProcessingStage,
  { code: string; label: string }
> = {
  capture_validation: {
    code: 'PAYPAL_CAPTURE_VALIDATION_FAILED',
    label: 'PayPal capture validation failed',
  },
  completion: {
    code: 'FULFILLMENT_COMPLETION_PERSISTENCE_FAILED',
    label: 'Fulfillment completion persistence failed',
  },
  django_fulfillment_handoff: {
    code: 'DJANGO_FULFILLMENT_HANDOFF_FAILED',
    label: 'Django fulfillment handoff failed',
  },
  django_payment_save: {
    code: 'DJANGO_PAYMENT_SAVE_FAILED',
    label: 'Django payment save failed',
  },
  ledger_validation: {
    code: 'PAID_LEDGER_VALIDATION_FAILED',
    label: 'Paid ledger validation failed',
  },
  merchize_order_registration: {
    code: 'MERCHIZE_ORDER_REGISTRATION_FAILED',
    label: 'Merchize Ops registration failed',
  },
  merchize_order_sync: {
    code: 'MERCHIZE_ORDER_SYNC_FAILED',
    label: 'Merchize order synchronization failed',
  },
  merchize_production_push: {
    code: 'MERCHIZE_PUSH_FAILED',
    label: 'Merchize production push failed',
  },
  merchize_push_verification: {
    code: 'MERCHIZE_PUSH_VERIFICATION_FAILED',
    label: 'Merchize push verification failed',
  },
  merchize_readiness: {
    code: 'MERCHIZE_READINESS_CHECK_FAILED',
    label: 'Merchize readiness check failed',
  },
  receipt_generation: {
    code: 'PAYMENT_RECEIPT_GENERATION_FAILED',
    label: 'Payment receipt generation failed',
  },
};

export class PaidFulfillmentProcessingError extends Error {
  readonly code: string;
  readonly stage: PaidFulfillmentProcessingStage;

  constructor({
    code,
    message,
    stage,
  }: {
    code: string;
    message: string;
    stage: PaidFulfillmentProcessingStage;
  }) {
    super(message);
    this.name = 'PaidFulfillmentProcessingError';
    this.code = code;
    this.stage = stage;
  }
}

function toPaidFulfillmentProcessingError(error: unknown, stage: PaidFulfillmentProcessingStage) {
  if (error instanceof PaidFulfillmentProcessingError) return error;

  const detail = PROCESSING_STAGE_DETAILS[stage];
  const providerMessage = error instanceof Error ? error.message : String(error);
  return new PaidFulfillmentProcessingError({
    code: detail.code,
    message: `${detail.label}: ${providerMessage}`,
    stage,
  });
}

function buildPaymentReceiptPayload(args: PaymentReceiptProps) {
  return encryptForPostProcessingServerAction(JSON.stringify(args));
}

function buildPaymentSavePayload(args: PaymentSavingActionProps) {
  return encryptForPostProcessingServerAction(JSON.stringify(args));
}

function toLedgerJson(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function clearLock(orderToken: string, lockId: string) {
  const result = await paypalTxLedger.paypalIntent.updateMany({
    where: { orderToken, postProcessingLockId: lockId },
    data: {
      postProcessingLockId: null,
      postProcessingLockedAt: null,
      postProcessingLockExpiresAt: null,
    },
  });

  if (result.count > 0) await refreshPaidOrderRecoveryProjectionSafely(orderToken);
}

async function updateLockedRow(
  orderToken: string,
  lockId: string,
  data: Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data'],
) {
  const result = await paypalTxLedger.paypalIntent.updateMany({
    where: { orderToken, postProcessingLockId: lockId },
    data,
  });

  if (result.count > 0) await refreshPaidOrderRecoveryProjectionSafely(orderToken);
}

async function markFulfillmentFailedAndNotify(args: {
  orderToken: string;
  lockId: string;
  row: {
    paypalOrderId: string | null;
    customerName: string;
    customerEmail: string;
    receiptLink: string | null;
  };
  errorCode: string;
  errorMessage: string;
  issueSummary?: string[];
  requestPayload?: unknown;
  responsePayload?: unknown;
  merchizeFulfillmentProcessingId?: string | null;
  merchizeProviderOrderId?: string | null;
  merchizeProviderOrderCode?: string | null;
}) {
  await paypalTxLedger.$transaction(async (tx) => {
    await tx.paypalIntent.updateMany({
      where: { orderToken: args.orderToken, postProcessingLockId: args.lockId },
      data: {
        status: PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
        lastErrorCode: args.errorCode,
        lastErrorMessage: args.errorMessage,
        merchizeFulfillmentRequestPayload:
          args.requestPayload === undefined ? undefined : toLedgerJson(args.requestPayload),
        merchizeFulfillmentResponsePayload:
          args.responsePayload === undefined ? undefined : toLedgerJson(args.responsePayload),
        merchizeFulfillmentProcessingId: args.merchizeFulfillmentProcessingId ?? undefined,
        merchizeProviderOrderId: args.merchizeProviderOrderId ?? undefined,
        merchizeProviderOrderCode: args.merchizeProviderOrderCode ?? undefined,
        postProcessingLockId: null,
        postProcessingLockedAt: null,
        postProcessingLockExpiresAt: null,
      } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data'],
    });

    await enqueueAdminRecoveryNotification({
      db: tx,
      orderToken: args.orderToken,
      paypalOrderId: args.row.paypalOrderId,
      customerName: args.row.customerName,
      customerEmail: args.row.customerEmail,
      ledgerStatus: PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      issueSummary: args.issueSummary ?? [args.errorMessage],
      receiptLink: args.row.receiptLink,
    });
  });
  await refreshPaidOrderRecoveryProjectionSafely(args.orderToken);

  await sendPendingAdminRecoveryNotificationsForOrder(args.orderToken).catch(
    (notificationError) => {
      console.error('[AdminNotificationOutbox] failed to send fulfillment failed alert', {
        orderToken: args.orderToken,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      });
    },
  );
}

async function markFulfillmentAttentionRequiredAndNotify(args: {
  orderToken: string;
  lockId: string;
  row: {
    paypalOrderId: string | null;
    customerName: string;
    customerEmail: string;
    receiptLink: string | null;
  };
  errorCode: string;
  errorMessage: string;
  issueSummary?: string[];
  requestPayload?: unknown;
  responsePayload?: unknown;
  merchizeFulfillmentProcessingId?: string | null;
  merchizeProviderOrderId?: string | null;
  merchizeProviderOrderCode?: string | null;
}) {
  await paypalTxLedger.$transaction(async (tx) => {
    await tx.paypalIntent.updateMany({
      where: { orderToken: args.orderToken, postProcessingLockId: args.lockId },
      data: {
        status: PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
        lastErrorCode: args.errorCode,
        lastErrorMessage: args.errorMessage,
        merchizeFulfillmentRequestPayload:
          args.requestPayload === undefined ? undefined : toLedgerJson(args.requestPayload),
        merchizeFulfillmentResponsePayload:
          args.responsePayload === undefined ? undefined : toLedgerJson(args.responsePayload),
        merchizeFulfillmentProcessingId: args.merchizeFulfillmentProcessingId ?? undefined,
        merchizeProviderOrderId: args.merchizeProviderOrderId ?? undefined,
        merchizeProviderOrderCode: args.merchizeProviderOrderCode ?? undefined,
        postProcessingLockId: null,
        postProcessingLockedAt: null,
        postProcessingLockExpiresAt: null,
      } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data'],
    });

    await enqueueAdminRecoveryNotification({
      db: tx,
      orderToken: args.orderToken,
      paypalOrderId: args.row.paypalOrderId,
      customerName: args.row.customerName,
      customerEmail: args.row.customerEmail,
      ledgerStatus: PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      issueSummary: args.issueSummary ?? [args.errorMessage],
      receiptLink: args.row.receiptLink,
      severity: ADMIN_NOTIFICATION_SEVERITY.WARNING,
    });
  });
  await refreshPaidOrderRecoveryProjectionSafely(args.orderToken);

  await sendPendingAdminRecoveryNotificationsForOrder(args.orderToken).catch(
    (notificationError) => {
      console.error('[AdminNotificationOutbox] failed to send fulfillment attention alert', {
        orderToken: args.orderToken,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      });
    },
  );
}

async function markFulfillmentLookupPendingForAutomaticRetry(args: {
  orderToken: string;
  lockId: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  merchizeFulfillmentProcessingId?: string | null;
  merchizeProviderOrderId?: string | null;
  merchizeProviderOrderCode?: string | null;
}) {
  await updateLockedRow(args.orderToken, args.lockId, {
    status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
    lastErrorCode: MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING_ERROR_CODE,
    lastErrorMessage: null,
    merchizeFulfillmentRequestPayload:
      args.requestPayload === undefined ? undefined : toLedgerJson(args.requestPayload),
    merchizeFulfillmentResponsePayload:
      args.responsePayload === undefined ? undefined : toLedgerJson(args.responsePayload),
    merchizeFulfillmentProcessingId: args.merchizeFulfillmentProcessingId ?? undefined,
    merchizeProviderOrderId: args.merchizeProviderOrderId ?? undefined,
    merchizeProviderOrderCode: args.merchizeProviderOrderCode ?? undefined,
    postProcessingLockId: null,
    postProcessingLockedAt: null,
    postProcessingLockExpiresAt: null,
  } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data']);

  console.info('[merchize.fulfillment_ops.lookup_pending_for_retry]', {
    orderToken: args.orderToken,
    errorCode: MERCHIZE_LOOKUP_PENDING_PROVIDER_PROCESSING_ERROR_CODE,
  });
}

async function markFulfillmentProviderPendingForAutomaticRetry(args: {
  orderToken: string;
  lockId: string;
  errorCode: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  merchizeFulfillmentProcessingId?: string | null;
  merchizeProviderOrderId?: string | null;
  merchizeProviderOrderCode?: string | null;
}) {
  await updateLockedRow(args.orderToken, args.lockId, {
    status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
    lastErrorCode: args.errorCode,
    lastErrorMessage: null,
    merchizeFulfillmentRequestPayload:
      args.requestPayload === undefined ? undefined : toLedgerJson(args.requestPayload),
    merchizeFulfillmentResponsePayload:
      args.responsePayload === undefined ? undefined : toLedgerJson(args.responsePayload),
    merchizeFulfillmentProcessingId: args.merchizeFulfillmentProcessingId ?? undefined,
    merchizeProviderOrderId: args.merchizeProviderOrderId ?? undefined,
    merchizeProviderOrderCode: args.merchizeProviderOrderCode ?? undefined,
    postProcessingLockId: null,
    postProcessingLockedAt: null,
    postProcessingLockExpiresAt: null,
  } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data']);

  console.info('[merchize.fulfillment_ops.provider_state_pending_for_retry]', {
    orderToken: args.orderToken,
    errorCode: args.errorCode,
  });
}

async function notifyFulfillmentPushVerified(args: {
  orderToken: string;
  row: {
    paypalOrderId: string | null;
    customerName: string;
    customerEmail: string;
    receiptLink: string | null;
  };
  merchizeExternalOrderNumber?: string | null;
  merchizeOrderId?: string | null;
  merchizeOrderCode?: string | null;
}) {
  await enqueueCustomerFulfillmentPushVerifiedNotification({
    orderToken: args.orderToken,
    paypalOrderId: args.row.paypalOrderId,
    customerName: args.row.customerName,
    customerEmail: args.row.customerEmail,
    receiptLink: args.row.receiptLink,
  }).catch((notificationError) => {
    console.error('[CustomerNotificationOutbox] failed to enqueue fulfillment success alert', {
      orderToken: args.orderToken,
      error:
        notificationError instanceof Error ? notificationError.message : String(notificationError),
    });
  });

  await enqueueAdminFulfillmentPushVerifiedNotification({
    orderToken: args.orderToken,
    paypalOrderId: args.row.paypalOrderId,
    customerName: args.row.customerName,
    customerEmail: args.row.customerEmail,
    receiptLink: args.row.receiptLink,
    merchizeExternalOrderNumber: args.merchizeExternalOrderNumber,
    merchizeOrderId: args.merchizeOrderId,
    merchizeOrderCode: args.merchizeOrderCode,
  }).catch((notificationError) => {
    console.error('[AdminNotificationOutbox] failed to enqueue fulfillment success alert', {
      orderToken: args.orderToken,
      error:
        notificationError instanceof Error ? notificationError.message : String(notificationError),
    });
  });

  await Promise.all([
    sendPendingCustomerNotificationsForOrder(args.orderToken).catch((notificationError) => {
      console.error('[CustomerNotificationOutbox] failed to send fulfillment success alert', {
        orderToken: args.orderToken,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      });
    }),
    sendPendingAdminRecoveryNotificationsForOrder(args.orderToken).catch((notificationError) => {
      console.error('[AdminNotificationOutbox] failed to send fulfillment success alert', {
        orderToken: args.orderToken,
        error:
          notificationError instanceof Error
            ? notificationError.message
            : String(notificationError),
      });
    }),
  ]);
}

export async function runPaidFulfillmentProcessing(
  orderToken: string,
  options: RunPaidFulfillmentProcessingOptions = {},
) {
  assertShopOpsMutationAllowed({
    localProductionMasterConfirmed: options.localProductionMasterConfirmed === true,
  });

  const now = new Date();
  const lockId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + POST_PROCESSING_LEASE_MS);

  // The lease prevents overlapping webhook retries from running the same side effects twice.
  const lease = await paypalTxLedger.paypalIntent.updateMany({
    where: {
      orderToken,
      processingCompletedAt: null,
      OR: [{ postProcessingLockExpiresAt: null }, { postProcessingLockExpiresAt: { lt: now } }],
    },
    data: {
      postProcessingLockId: lockId,
      postProcessingLockedAt: now,
      postProcessingLockExpiresAt: leaseExpiresAt,
      processingTriggerDetail: options.triggerDetail ?? null,
      processingTriggerSource: options.triggerSource ?? null,
      processingTriggeredAt: now,
    },
  });

  if (lease.count === 0) return;

  const row = await paypalTxLedger.paypalIntent.findUnique({ where: { orderToken } });
  if (!row) {
    throw new Error('Ledger row not found');
  }

  if (row.postProcessingLockId !== lockId) return;

  if (row.processingCompletedAt || row.status === PAYPAL_LEDGER_STATUS.COMPLETED) {
    await clearLock(orderToken, lockId);
    return;
  }

  let activeStage: PaidFulfillmentProcessingStage = 'ledger_validation';

  try {
    const authData = row.authorizePayload as PaymentReceiptProps['authData'] | null;
    const finalCapturedOrder = row.capturePayload as
      PaymentSavingActionProps['finalCapturedOrder'] | null;

    if (!authData || !finalCapturedOrder) {
      throw new Error('Missing authorize/capture payload in ledger');
    }

    activeStage = 'capture_validation';
    const captureCompletion = getPayPalCaptureCompletion(finalCapturedOrder);
    if (!captureCompletion.ok) {
      await updateLockedRow(orderToken, lockId, {
        status:
          captureCompletion.status === 'PENDING'
            ? PAYPAL_LEDGER_STATUS.PENDING
            : PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: 'CAPTURE_NOT_COMPLETED',
        lastErrorMessage: captureCompletion.reason,
        postProcessingLockId: null,
        postProcessingLockedAt: null,
        postProcessingLockExpiresAt: null,
      });
      throw new Error(captureCompletion.reason);
    }

    // Final defense shared by capture-route, webhook, scanner, reconciliation, and admin triggers.
    // New rows must have an intact envelope and an exact captured amount/currency; all-null rows
    // remain on the legacy path. This runs before either full or fulfillment-only side effects.
    const canonicalPayment = reconcileCanonicalPayPalPaymentChain(
      row,
      authData,
      finalCapturedOrder,
    );
    if (!canonicalPayment.ok) {
      throw new PaidFulfillmentProcessingError({
        code: canonicalPayment.reconciliation.errorCode,
        message: canonicalPayment.reconciliation.reason,
        stage: 'capture_validation',
      });
    }
    const canonicalOrderSnapshot = canonicalPayment.snapshot;

    if (options.executionScope === 'merchize_fulfillment_only') {
      const acceptedDjangoHandoff = isAcceptedDjangoFulfillmentProcessResponse(
        row.merchizeFulfillmentResponsePayload,
      );
      const merchizeExternalOrderNumber = acceptedDjangoHandoff
        ? extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
            row.merchizeFulfillmentResponsePayload,
          )
        : null;
      const eligibility = getMerchizeFulfillmentRetryEligibility({
        captureComplete: captureCompletion.ok,
        hasAcceptedDjangoFulfillmentHandoff: acceptedDjangoHandoff,
        hasDjangoPaymentSaveCustomId: Boolean(row.djangoPaymentSaveCustomId),
        hasMerchizeExternalOrderNumber: Boolean(merchizeExternalOrderNumber),
        hasPersistedReceipt: Boolean(row.receiptLink && row.receiptFile),
      });

      if (!eligibility.eligible) {
        throw new PaidFulfillmentProcessingError({
          code: eligibility.code,
          message: eligibility.message,
          stage:
            eligibility.missingCheckpoint === 'receipt'
              ? 'receipt_generation'
              : eligibility.missingCheckpoint === 'django_payment_save'
                ? 'django_payment_save'
                : eligibility.missingCheckpoint === 'capture'
                  ? 'capture_validation'
                  : 'django_fulfillment_handoff',
        });
      }
    }

    const customer = {
      name: row.customerName,
      email: row.customerEmail,
    };
    const ORD_string = row.djangoOrderIntentOrderId ?? row.orderToken;

    if (!row.receiptLink || !row.receiptFile) {
      activeStage = 'receipt_generation';
      const receiptRes = await savePaymentReceiptToCloud(
        buildPaymentReceiptPayload({
          authData,
          cart: canonicalOrderSnapshot ? undefined : (row.cartSnapshot as CartVariant[]),
          canonicalOrderSnapshot,
          customer,
          ORD_string,
          shippingAddressOverride:
            (row.fulfillmentAddressOverride as PaymentReceiptProps['shippingAddressOverride']) ??
            null,
        }),
      );

      if (
        !receiptRes.success ||
        !('pdfReceiptLink' in receiptRes) ||
        !('receiptFileName' in receiptRes)
      ) {
        throw new Error('message' in receiptRes ? receiptRes.message : 'Receipt upload failed');
      }

      await updateLockedRow(orderToken, lockId, {
        status: PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
        receiptLink: receiptRes.pdfReceiptLink,
        receiptFile: receiptRes.receiptFileName,
        lastErrorCode: null,
        lastErrorMessage: null,
      });

      row.receiptLink = receiptRes.pdfReceiptLink;
      row.receiptFile = receiptRes.receiptFileName;
    }

    if (!row.djangoPaymentSaveCustomId) {
      activeStage = 'django_payment_save';
      const paymentSave = await savePaymentDataToBackend(
        buildPaymentSavePayload({
          authData,
          capturedOrder: finalCapturedOrder,
          finalCapturedOrder,
          capturedOrderPaypalID: finalCapturedOrder.id ?? row.paypalOrderId ?? row.orderToken,
          customer,
          delivery_address: row.shippingSnapshot as PaymentSavingActionProps['delivery_address'],
          userId: row.userId,
          ORD_string,
          country_iso2: row.countryIso2 ?? 'US',
          pdfReceiptLink: row.receiptLink ?? '',
          receiptFileName: row.receiptFile ?? '',
          canonicalOrderSnapshot,
        }),
      );

      if (!paymentSave.ok) {
        throw new Error(paymentSave.error?.message ?? 'Payment save failed');
      }

      const djangoPaymentSaveCustomId = paymentSave.data?.custom_id ?? null;

      await updateLockedRow(orderToken, lockId, {
        status: PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
        djangoPaymentSaveCustomId,
        djangoPaymentSaveResponsePayload: JSON.parse(JSON.stringify(paymentSave)),
        lastErrorCode: null,
        lastErrorMessage: null,
      } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data']);

      row.djangoPaymentSaveCustomId = djangoPaymentSaveCustomId;
    }

    if (!row.djangoPaymentSaveCustomId) {
      activeStage = 'django_payment_save';
      throw new Error('Missing Django payment save custom_id before fulfillment push');
    }

    const fulfillmentAddress =
      (row.fulfillmentAddressOverride as PaymentSavingActionProps['delivery_address'] | null) ??
      (row.shippingSnapshot as PaymentSavingActionProps['delivery_address']);
    let fulfillmentRequestPayload: unknown = row.merchizeFulfillmentRequestPayload;
    let fulfillmentResponsePayload: unknown = row.merchizeFulfillmentResponsePayload;
    let merchizeFulfillmentProcessingId = row.merchizeFulfillmentProcessingId;
    let merchizeProviderOrderId = row.merchizeProviderOrderId;
    let merchizeProviderOrderCode = row.merchizeProviderOrderCode;
    let merchizeProviderStatus: string | null = null;
    let merchizeExternalOrderNumber = isAcceptedDjangoFulfillmentProcessResponse(
      row.merchizeFulfillmentResponsePayload,
    )
      ? extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
          row.merchizeFulfillmentResponsePayload,
          row.djangoOrderIntentOrderId,
        )
      : null;

    if (!merchizeExternalOrderNumber) {
      activeStage = 'django_fulfillment_handoff';
      const fulfillmentSend = await sendMerchizeFulfillmentOrder({
        cartSnapshot: row.cartSnapshot as CartVariant[],
        canonicalOrderSnapshot,
        djangoPaymentSaveCustomId: row.djangoPaymentSaveCustomId,
        identifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
        currency: canonicalOrderSnapshot?.currency ?? row.initialCurrency ?? 'USD',
        customerName: row.customerName,
        countryIso2: row.countryIso2,
        fulfillmentAddress,
      });

      fulfillmentRequestPayload = fulfillmentSend.requestPayload;
      fulfillmentResponsePayload = {
        ok: fulfillmentSend.ok,
        status: fulfillmentSend.status,
        success: fulfillmentSend.success,
        message: fulfillmentSend.message,
        data: fulfillmentSend.data,
      };
      merchizeFulfillmentProcessingId = fulfillmentSend.data?.id ?? null;
      merchizeProviderOrderId = fulfillmentSend.merchizeOrderIdentifiers.merchizeProviderOrderId;
      merchizeProviderOrderCode =
        fulfillmentSend.merchizeOrderIdentifiers.merchizeProviderOrderCode;
      merchizeProviderStatus = fulfillmentSend.merchizeOrderIdentifiers.merchizeProviderStatus;
      merchizeExternalOrderNumber =
        fulfillmentSend.merchizeOrderIdentifiers.merchizeExternalOrderNumber;

      await updateLockedRow(orderToken, lockId, {
        merchizeFulfillmentRequestPayload: toLedgerJson(fulfillmentRequestPayload),
        merchizeFulfillmentResponsePayload: toLedgerJson(fulfillmentResponsePayload),
        merchizeFulfillmentProcessingId,
        merchizeProviderOrderId,
        merchizeProviderOrderCode,
        lastErrorCode: null,
        lastErrorMessage: null,
      } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data']);
    }

    if (merchizeExternalOrderNumber) {
      activeStage = 'merchize_order_registration';
      await registerAcceptedMerchizeFulfillmentProcess({
        orderToken,
        paypalOrderId: row.paypalOrderId,
        djangoOrderIntentUuid: row.djangoOrderIntentUuid,
        djangoOrderIntentOrderId: row.djangoOrderIntentOrderId,
        djangoPaymentSaveCustomId: row.djangoPaymentSaveCustomId,
        fulfillmentIdentifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
        merchizeExternalOrderNumber,
        merchizeOrderId: null,
        merchizeOrderCode: merchizeProviderOrderCode ?? merchizeExternalOrderNumber,
        merchizeStatus: merchizeProviderStatus,
        djangoProcessResponsePayload: fulfillmentResponsePayload,
        customerEmail: row.customerEmail,
        shippingSnapshot: fulfillmentAddress,
        cartSnapshot: row.cartSnapshot,
        canonicalOrderSnapshot: row.canonicalOrderSnapshot,
        canonicalOrderSnapshotVersion: row.canonicalOrderSnapshotVersion,
        canonicalOrderSnapshotHash: row.canonicalOrderSnapshotHash,
      });

      activeStage = 'merchize_order_sync';
      const sync = await syncMerchizeFulfillmentOrder(orderToken);
      if (!sync.ok) {
        if (isMerchizeLookupPendingProviderProcessingError(sync.errorCode)) {
          await markFulfillmentLookupPendingForAutomaticRetry({
            orderToken,
            lockId,
            requestPayload: fulfillmentRequestPayload,
            responsePayload: fulfillmentResponsePayload,
            merchizeFulfillmentProcessingId,
            merchizeProviderOrderId,
            merchizeProviderOrderCode,
          });
          return;
        }

        await markFulfillmentFailedAndNotify({
          orderToken,
          lockId,
          row,
          errorCode: sync.errorCode,
          errorMessage: sync.errorMessage,
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      activeStage = 'merchize_readiness';
      const readinessCheck = await runMerchizeProductionReadinessChecks(orderToken, {
        allowStaleOrderManualRelease: options.allowStaleMerchizeOrderManualRelease,
        expectedBuyerAddress: getMerchizeBuyerAddressExpectationFromLedger(fulfillmentAddress),
      });
      if (!readinessCheck.ok) {
        await markFulfillmentProviderPendingForAutomaticRetry({
          orderToken,
          lockId,
          errorCode: readinessCheck.errorCode,
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      const { readiness } = readinessCheck;
      if (!readiness.ready) {
        const primaryBlocker = readiness.primaryBlocker;
        const errorCode = primaryBlocker?.code ?? 'MERCHIZE_PRODUCTION_READINESS_BLOCKED';
        const errorMessage =
          primaryBlocker?.message ?? 'Merchize production-readiness checks did not pass.';
        const retryableOnly =
          readiness.blockers.length > 0 && readiness.blockers.every((blocker) => blocker.retryable);

        if (retryableOnly) {
          await markFulfillmentProviderPendingForAutomaticRetry({
            orderToken,
            lockId,
            errorCode,
            requestPayload: fulfillmentRequestPayload,
            responsePayload: fulfillmentResponsePayload,
            merchizeFulfillmentProcessingId,
            merchizeProviderOrderId,
            merchizeProviderOrderCode,
          });
          return;
        }

        await markFulfillmentAttentionRequiredAndNotify({
          orderToken,
          lockId,
          row,
          errorCode,
          errorMessage,
          issueSummary: readiness.blockers.map((blocker) => blocker.message),
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      let pushVerification: Awaited<ReturnType<typeof verifyMerchizeFulfillmentPush>> | null = null;
      if (readiness.providerPushState === 'pushed') {
        activeStage = 'merchize_push_verification';
        pushVerification = await verifyMerchizeFulfillmentPush(orderToken, {
          retryDelaysMs: [0],
        });
      }

      if (
        !pushVerification &&
        !options.overrideMerchizeFulfillmentPushDisabled &&
        !isMerchizeFulfillmentPushEnabled()
      ) {
        const message =
          'Merchize push-to-fulfillment is disabled by MERCHIZE_FULFILLMENT_PUSH_ENABLED=false.';
        await recordMerchizeFulfillmentPushDisabledByConfig({
          orderToken,
          merchizeExternalOrderNumber,
          merchizeOrderCode: merchizeProviderOrderCode,
          identifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
        });
        await markFulfillmentAttentionRequiredAndNotify({
          orderToken,
          lockId,
          row,
          errorCode: 'MERCHIZE_PUSH_DISABLED_BY_CONFIG',
          errorMessage: message,
          issueSummary: [
            'Payment-side work completed and the provider order was registered.',
            'Merchize push-to-fulfillment was skipped because production push is disabled by configuration.',
            'Use master-admin manual release when this order is safe to push.',
          ],
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      if (!pushVerification) {
        const acknowledgedRecently =
          readinessCheck.pushAcknowledgedAt &&
          !readinessCheck.pushVerifiedAt &&
          Date.now() - readinessCheck.pushAcknowledgedAt.getTime() < POST_PROCESSING_LEASE_MS;
        const shouldVerifyExistingPush =
          readiness.providerPushState === 'pending' || acknowledgedRecently;

        if (!shouldVerifyExistingPush) {
          try {
            activeStage = 'merchize_production_push';
            await pushMerchizeFulfillmentOrderToProduction({
              orderToken,
              merchizeExternalOrderNumber,
              merchizeOrderCode: merchizeProviderOrderCode,
              identifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
            });
          } catch (pushError) {
            const message =
              pushError instanceof Error
                ? pushError.message
                : 'Merchize push-to-fulfillment failed.';
            await markFulfillmentFailedAndNotify({
              orderToken,
              lockId,
              row,
              errorCode:
                pushError instanceof MerchizeFulfillmentPushError
                  ? pushError.code
                  : 'MERCHIZE_PUSH_FAILED',
              errorMessage: message,
              requestPayload: fulfillmentRequestPayload,
              responsePayload: fulfillmentResponsePayload,
              merchizeFulfillmentProcessingId,
              merchizeProviderOrderId,
              merchizeProviderOrderCode,
            });
            return;
          }
        }

        activeStage = 'merchize_push_verification';
        pushVerification = await verifyMerchizeFulfillmentPush(orderToken);
      }

      if (pushVerification.status === 'pending') {
        await markFulfillmentProviderPendingForAutomaticRetry({
          orderToken,
          lockId,
          errorCode: 'MERCHIZE_PUSH_VERIFICATION_PENDING',
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      if (pushVerification.status === 'failed') {
        await markFulfillmentFailedAndNotify({
          orderToken,
          lockId,
          row,
          errorCode: pushVerification.errorCode,
          errorMessage: pushVerification.errorMessage,
          issueSummary: [
            pushVerification.errorMessage,
            'Review the provider address, explicit item/artwork evidence, provider attention, and push state before retrying.',
          ],
          requestPayload: fulfillmentRequestPayload,
          responsePayload: fulfillmentResponsePayload,
          merchizeFulfillmentProcessingId,
          merchizeProviderOrderId,
          merchizeProviderOrderCode,
        });
        return;
      }

      activeStage = 'completion';
      await updateLockedRow(orderToken, lockId, {
        status: PAYPAL_LEDGER_STATUS.COMPLETED,
        merchizeFulfillmentRequestPayload: toLedgerJson(fulfillmentRequestPayload),
        merchizeFulfillmentResponsePayload: toLedgerJson(fulfillmentResponsePayload),
        merchizeFulfillmentProcessingId,
        merchizeProviderOrderId,
        merchizeProviderOrderCode,
        processingCompletedAt: new Date(),
        postProcessingLockId: null,
        postProcessingLockedAt: null,
        postProcessingLockExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data']);

      await syncMerchizeFulfillmentOperationalSnapshots(orderToken).catch((snapshotError) => {
        console.error('[merchize.fulfillment_ops.operational_snapshot_failed]', {
          orderToken,
          merchizeExternalOrderNumber,
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
      });

      await notifyFulfillmentPushVerified({
        orderToken,
        row,
        merchizeExternalOrderNumber,
        merchizeOrderId: sync.merchizeOrderId,
        merchizeOrderCode: merchizeProviderOrderCode,
      });
    } else {
      await markFulfillmentFailedAndNotify({
        orderToken,
        lockId,
        row,
        errorCode: 'MERCHIZE_EXTERNAL_ORDER_NUMBER_MISSING',
        errorMessage: 'Merchize external order number was missing after Django process acceptance.',
        requestPayload: fulfillmentRequestPayload,
        responsePayload: fulfillmentResponsePayload,
        merchizeFulfillmentProcessingId,
        merchizeProviderOrderId,
        merchizeProviderOrderCode,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof FulfillmentPayloadValidationError) {
      await paypalTxLedger.$transaction(async (tx) => {
        await tx.paypalIntent.updateMany({
          where: { orderToken, postProcessingLockId: lockId },
          data: {
            status: PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
            lastErrorCode: 'FULFILLMENT_PAYLOAD_INVALID',
            lastErrorMessage: message,
            merchizeFulfillmentRequestPayload: toLedgerJson(error.requestPayload),
            merchizeFulfillmentResponsePayload: toLedgerJson({
              source: 'local_validation',
              success: false,
              issues: error.issues,
            }),
            postProcessingLockId: null,
            postProcessingLockedAt: null,
            postProcessingLockExpiresAt: null,
          } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data'],
        });

        await enqueueAdminRecoveryNotification({
          db: tx,
          orderToken,
          paypalOrderId: row.paypalOrderId,
          customerName: row.customerName,
          customerEmail: row.customerEmail,
          ledgerStatus: PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
          errorCode: 'FULFILLMENT_PAYLOAD_INVALID',
          errorMessage: message,
          issueSummary: error.issues.map((issue) => issue.message),
          receiptLink: row.receiptLink,
        });
      });
      await refreshPaidOrderRecoveryProjectionSafely(orderToken);

      await sendPendingAdminRecoveryNotificationsForOrder(orderToken).catch((notificationError) => {
        console.error('[AdminNotificationOutbox] failed to send fulfillment blocked alert', {
          orderToken,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        });
      });

      return;
    }

    if (error instanceof FulfillmentProviderRejectedError) {
      await paypalTxLedger.$transaction(async (tx) => {
        await tx.paypalIntent.updateMany({
          where: { orderToken, postProcessingLockId: lockId },
          data: {
            status: PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
            lastErrorCode: 'FULFILLMENT_PROVIDER_REJECTED',
            lastErrorMessage: message,
            merchizeFulfillmentRequestPayload: toLedgerJson(error.requestPayload),
            merchizeFulfillmentResponsePayload: toLedgerJson(error.responsePayload),
            merchizeFulfillmentProcessingId: error.responsePayload.data?.id ?? null,
            merchizeProviderOrderId: error.responsePayload.data?.provider_order_id ?? null,
            merchizeProviderOrderCode: error.responsePayload.data?.provider_order_code ?? null,
            postProcessingLockId: null,
            postProcessingLockedAt: null,
            postProcessingLockExpiresAt: null,
          } as Parameters<typeof paypalTxLedger.paypalIntent.updateMany>[0]['data'],
        });

        await enqueueAdminRecoveryNotification({
          db: tx,
          orderToken,
          paypalOrderId: row.paypalOrderId,
          customerName: row.customerName,
          customerEmail: row.customerEmail,
          ledgerStatus: PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
          errorCode: 'FULFILLMENT_PROVIDER_REJECTED',
          errorMessage: message,
          issueSummary: [message],
          receiptLink: row.receiptLink,
        });
      });
      await refreshPaidOrderRecoveryProjectionSafely(orderToken);

      await sendPendingAdminRecoveryNotificationsForOrder(orderToken).catch((notificationError) => {
        console.error('[AdminNotificationOutbox] failed to send fulfillment failed alert', {
          orderToken,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        });
      });

      return;
    }

    const processingError = toPaidFulfillmentProcessingError(error, activeStage);
    const prerequisiteFailure = processingError.code.startsWith('MERCHIZE_RETRY_');

    await updateLockedRow(orderToken, lockId, {
      status: prerequisiteFailure ? row.status : PAYPAL_LEDGER_STATUS.ERROR,
      lastErrorCode: processingError.code,
      lastErrorMessage: processingError.message,
      postProcessingLockId: null,
      postProcessingLockedAt: null,
      postProcessingLockExpiresAt: null,
    });

    throw processingError;
  }
}
