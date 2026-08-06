import 'server-only';

import { getCanonicalPaymentProjectionState } from '@/lib/paypal/txLedger/canonicalPaymentProjectionState';
import { isAcceptedDjangoFulfillmentProcessResponse } from '@/lib/paypal/txLedger/fulfillmentProcessResponse';
import {
  getPayPalLedgerInferredProcessingSourceDisplay,
  getPayPalLedgerProcessingSourceDisplay,
} from '@/lib/paypal/txLedger/paypalLedgerProvenance';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import {
  getMerchizeFulfillmentOpsPrisma,
  isMerchizeFulfillmentOpsDatabaseConfigured,
} from '@/lib/prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOpsPrisma';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { extractMerchizeExternalOrderNumberFromDjangoProcessResponse } from '@/lib/merchizeFulfillmentOps/merchizeMapper';
import { MERCHIZE_FULFILLMENT_SYNC_STATUS } from '@/lib/merchizeFulfillmentOps/status';
import { isMerchizeLookupPendingProviderProcessingError } from '@/lib/merchizeFulfillmentOps/lookupPending';
import { safeLogErrorMessage } from '@/lib/merchizeFulfillmentOps/redaction';
import { resolvePaidOrderRecoveryIssue } from '@/lib/paypal/txLedger/recoveryIssuePrecedence';
import type { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';

const ADMIN_RECOVERY_LEDGER_STATUSES = [
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.ERROR,
  PAYPAL_LEDGER_STATUS.COMPLETED,
] as const;

const CUSTOMER_PROTECTION_LEDGER_STATUSES = [
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.ERROR,
] as const;

const DETAIL_OR_PUSH_SYNCED_STATUSES = new Set<string>([
  MERCHIZE_FULFILLMENT_SYNC_STATUS.DETAIL_SYNCED,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.READINESS_CHECKING,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.READINESS_BLOCKED,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.READINESS_READY,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_PENDING,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_ACKNOWLEDGED,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_VERIFICATION_PENDING,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_VERIFIED,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_FAILED,
  MERCHIZE_FULFILLMENT_SYNC_STATUS.PUSH_DISABLED,
]);
const FULL_POST_PROCESSING_RETRY_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.ERROR,
]);
const FULFILLMENT_RETRY_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
]);

type AdminRecoveryStatus = 'failed' | 'recovery' | 'pending' | 'completed' | 'sync' | 'attention';

type JsonRecord = Record<string, unknown>;

type ProjectionLedgerRow = NonNullable<Awaited<ReturnType<typeof getProjectionLedgerRow>>>;

type ProjectionMerchizeOpsRow = {
  syncStatus: string;
  productionGateStatus: string | null;
  merchizeExternalOrderNumber: string;
  merchizeOrderId: string | null;
  merchizeOrderCode: string | null;
  merchizeStatus: string | null;
  progressStatus: string | null;
  deliveryStatus: string | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorMessage: string | null;
  updatedAt: Date;
};

type ProjectionWebhookRow = {
  eventType: string;
  processingStatus: string;
  matchedWebhookBindingKey: string | null;
  matchedWebhookLabel: string | null;
  matchedWebhookSource: string | null;
  webhookVerificationMode: string | null;
};

export type PaidOrderRecoveryProjectionRefreshResult =
  | {
      ok: true;
      orderToken: string;
      adminRecoveryStatus: AdminRecoveryStatus;
      isQueueVisible: boolean;
      isCustomerProtectionVisible: boolean;
    }
  | {
      ok: false;
      orderToken: string;
      reason: string;
    };

export type PaidOrderRecoveryProjectionBackfillResult = {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  refreshed: number;
  skipped: number;
  nextCursorOrderToken: string | null;
  orderTokens: string[];
  errors: Array<{ orderToken: string; error: string }>;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getPath(root: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined;
    return asRecord(current)?.[key];
  }, root);
}

function getCaptureAmountLabel(capturePayload: unknown, fallbackCurrency?: string | null) {
  const amountPaths = [
    ['amount'],
    ['sellerReceivableBreakdown', 'grossAmount'],
    ['seller_receivable_breakdown', 'gross_amount'],
    ['purchaseUnits', 0, 'payments', 'captures', 0, 'amount'],
    ['purchase_units', 0, 'payments', 'captures', 0, 'amount'],
  ];

  for (const path of amountPaths) {
    const amount = asRecord(getPath(capturePayload, path));
    const value = asNumber(amount?.value);
    const currency =
      asString(amount?.currencyCode) ?? asString(amount?.currency_code) ?? fallbackCurrency;

    if (value !== null && currency) {
      try {
        return new Intl.NumberFormat('en', {
          style: 'currency',
          currency,
        }).format(value);
      } catch {
        return `${currency} ${value.toFixed(2)}`;
      }
    }
  }

  return null;
}

function getWebhookSourceLabel(webhook: ProjectionWebhookRow | null) {
  if (!webhook) return null;
  if (webhook.matchedWebhookLabel) return webhook.matchedWebhookLabel;
  if (webhook.matchedWebhookBindingKey)
    return webhook.matchedWebhookBindingKey.replaceAll('_', ' ');
  if (webhook.matchedWebhookSource) return webhook.matchedWebhookSource.replaceAll('_', ' ');
  if (webhook.webhookVerificationMode === 'disabled') return 'Signature verification disabled';

  return null;
}

function needsProviderDetailSync(payload: unknown, merchizeOpsSyncStatus?: string | null) {
  return (
    isAcceptedDjangoFulfillmentProcessResponse(payload) &&
    !DETAIL_OR_PUSH_SYNCED_STATUSES.has(merchizeOpsSyncStatus ?? '')
  );
}

function getAdminRecoveryStatus(args: {
  ledgerStatus: string;
  needsProviderDetailSync: boolean;
}): AdminRecoveryStatus {
  if (args.needsProviderDetailSync) return 'sync';
  if (args.ledgerStatus === PAYPAL_LEDGER_STATUS.COMPLETED) return 'completed';
  if (
    args.ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED ||
    args.ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED ||
    args.ledgerStatus === PAYPAL_LEDGER_STATUS.ERROR
  ) {
    return 'failed';
  }
  if (args.ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED) {
    return 'attention';
  }
  if (
    args.ledgerStatus === PAYPAL_LEDGER_STATUS.CAPTURED ||
    args.ledgerStatus === PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED
  ) {
    return 'recovery';
  }

  return 'pending';
}

function getRecoveryStage(status: AdminRecoveryStatus, ledgerStatus: string) {
  if (status === 'sync') return 'Provider Detail Sync';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED) return 'Fulfillment Blocked';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED) return 'Fulfillment Failed';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED) {
    return 'Fulfillment Attention Required';
  }
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.PAYMENT_SAVED) return 'Payment Saved';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED) return 'Receipt Prepared';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.CAPTURED) return 'Payment Captured';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.COMPLETED) return 'Completed';
  if (ledgerStatus === PAYPAL_LEDGER_STATUS.ERROR) return 'Post-processing Error';
  return 'In Progress';
}

function getRecoveryReason(args: {
  adminRecoveryStatus: AdminRecoveryStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  merchizeOpsSyncStatus?: string | null;
  merchizeOpsLastSyncErrorCode?: string | null;
}) {
  if (args.adminRecoveryStatus === 'sync') {
    if (isMerchizeLookupPendingProviderProcessingError(args.merchizeOpsLastSyncErrorCode)) {
      return 'Merchize is still indexing the accepted order; scanner/admin retry will resume sync.';
    }
    if (args.merchizeOpsSyncStatus === MERCHIZE_FULFILLMENT_SYNC_STATUS.LOOKUP_PENDING) {
      return 'Fulfillment accepted; provider lookup is pending.';
    }
    return 'Fulfillment accepted; sync provider details';
  }

  if (!args.lastErrorCode && !args.lastErrorMessage) return '—';
  if (args.lastErrorCode === 'FULFILLMENT_PAYLOAD_INVALID') return 'Payload Validation Failed';
  if (args.lastErrorCode === 'FULFILLMENT_PROVIDER_REJECTED') {
    return 'Provider Rejected Fulfillment';
  }
  if (isMerchizeLookupPendingProviderProcessingError(args.lastErrorCode)) {
    return 'Provider Lookup Pending';
  }
  if (args.lastErrorCode === 'MERCHIZE_PUSH_DISABLED_BY_CONFIG') {
    return 'Push Disabled by Config';
  }
  if (args.lastErrorCode === 'POST_PROCESSING_FAILED') return 'Post-processing Failed';

  return args.lastErrorMessage ?? args.lastErrorCode ?? 'Unknown error';
}

function getRecoverySeverity(status: AdminRecoveryStatus) {
  if (status === 'failed') return 'critical';
  if (status === 'attention') return 'warning';
  if (status === 'sync') return 'info';
  if (status === 'recovery') return 'warning';
  if (status === 'completed') return 'success';
  return 'pending';
}

function getCustomerRecoveryStatus(args: {
  isPaid: boolean;
  isResolved: boolean;
  isCustomerProtectionVisible: boolean;
}) {
  if (!args.isPaid) return 'not_paid';
  if (args.isResolved) return 'resolved';
  if (args.isCustomerProtectionVisible) return 'paid_unresolved';
  return 'not_recoverable';
}

function getProjectionLedgerRow(orderToken: string) {
  return paypalTxLedger.paypalIntent.findUnique({
    where: { orderToken },
    select: {
      orderToken: true,
      paypalOrderId: true,
      djangoOrderIntentUuid: true,
      djangoOrderIntentOrderId: true,
      djangoOrderIntentVerifyPayload: true,
      djangoPaymentSaveCustomId: true,
      userId: true,
      customerEmail: true,
      customerName: true,
      status: true,
      authorizePayload: true,
      capturePayload: true,
      canonicalOrderSnapshot: true,
      canonicalOrderSnapshotVersion: true,
      canonicalOrderSnapshotHash: true,
      initialCurrency: true,
      merchizeFulfillmentResponsePayload: true,
      merchizeProviderOrderId: true,
      merchizeProviderOrderCode: true,
      receiptLink: true,
      receiptFile: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      processingTriggerDetail: true,
      processingTriggeredAt: true,
      processingTriggerSource: true,
      checkoutSurfaceHost: true,
      checkoutSurfaceLabel: true,
      processingCompletedAt: true,
      updatedAt: true,
    },
  });
}

async function getProjectionMerchizeOpsRow(
  orderToken: string,
): Promise<ProjectionMerchizeOpsRow | null> {
  if (!isMerchizeFulfillmentOpsDatabaseConfigured()) return null;

  try {
    return await getMerchizeFulfillmentOpsPrisma().merchizeFulfillmentOrder.findFirst({
      where: { orderToken },
      orderBy: { updatedAt: 'desc' },
      select: {
        syncStatus: true,
        productionGateStatus: true,
        merchizeExternalOrderNumber: true,
        merchizeOrderId: true,
        merchizeOrderCode: true,
        merchizeStatus: true,
        progressStatus: true,
        deliveryStatus: true,
        lastSyncErrorCode: true,
        lastSyncErrorMessage: true,
        updatedAt: true,
      },
    });
  } catch (error) {
    console.error('[paid_order_recovery_projection.merchize_ops_lookup_failed]', {
      orderToken,
      error: safeLogErrorMessage(error),
    });
    return null;
  }
}

async function getProjectionWebhookRow(
  row: Pick<ProjectionLedgerRow, 'orderToken' | 'paypalOrderId'>,
): Promise<ProjectionWebhookRow | null> {
  return paypalTxLedger.paypalWebhookEvent.findFirst({
    where: {
      OR: [
        { orderToken: row.orderToken },
        ...(row.paypalOrderId ? [{ paypalOrderId: row.paypalOrderId }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      eventType: true,
      processingStatus: true,
      matchedWebhookBindingKey: true,
      matchedWebhookLabel: true,
      matchedWebhookSource: true,
      webhookVerificationMode: true,
    },
  });
}

function buildProjectionData({
  ledgerRow,
  merchizeOpsRow,
  webhookRow,
}: {
  ledgerRow: ProjectionLedgerRow;
  merchizeOpsRow: ProjectionMerchizeOpsRow | null;
  webhookRow: ProjectionWebhookRow | null;
}): Prisma.PaidOrderRecoveryProjectionUncheckedCreateInput {
  const paymentState = getCanonicalPaymentProjectionState(ledgerRow);
  const { isPaid, paymentFailure, paymentSafeForPostProcessing } = paymentState;
  const providerDetailSyncNeeded = needsProviderDetailSync(
    ledgerRow.merchizeFulfillmentResponsePayload,
    merchizeOpsRow?.syncStatus,
  );
  const adminRecoveryStatus = paymentFailure
    ? 'failed'
    : getAdminRecoveryStatus({
        ledgerStatus: ledgerRow.status,
        needsProviderDetailSync: providerDetailSyncNeeded,
      });
  const isResolved =
    !paymentFailure &&
    (ledgerRow.status === PAYPAL_LEDGER_STATUS.COMPLETED ||
      ledgerRow.status === PAYPAL_LEDGER_STATUS.REFUNDED ||
      Boolean(ledgerRow.processingCompletedAt));
  const isQueueVisible =
    Boolean(paymentFailure) ||
    ADMIN_RECOVERY_LEDGER_STATUSES.includes(
      ledgerRow.status as (typeof ADMIN_RECOVERY_LEDGER_STATUSES)[number],
    ) || providerDetailSyncNeeded;
  const isCustomerProtectionVisible =
    isPaid &&
    !isResolved &&
    Boolean(ledgerRow.djangoOrderIntentOrderId) &&
    Boolean(ledgerRow.djangoOrderIntentVerifyPayload) &&
    (Boolean(paymentFailure) ||
      CUSTOMER_PROTECTION_LEDGER_STATUSES.includes(
        ledgerRow.status as (typeof CUSTOMER_PROTECTION_LEDGER_STATUSES)[number],
      ));
  const latestWebhookSourceLabel = getWebhookSourceLabel(webhookRow);
  const processingSource = getPayPalLedgerProcessingSourceDisplay(
    {
      latestWebhookSourceLabel,
      processingTriggerDetail: ledgerRow.processingTriggerDetail,
      processingTriggerSource: ledgerRow.processingTriggerSource,
    },
    getPayPalLedgerInferredProcessingSourceDisplay({
      checkoutSurfaceLabel: ledgerRow.checkoutSurfaceLabel,
      hasCapturePayload: Boolean(ledgerRow.capturePayload),
      ledgerStatus: ledgerRow.status,
    }) ?? undefined,
  );
  const merchizeExternalOrderNumber =
    merchizeOpsRow?.merchizeExternalOrderNumber ??
    ledgerRow.merchizeProviderOrderCode ??
    extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
      ledgerRow.merchizeFulfillmentResponsePayload,
      ledgerRow.djangoOrderIntentOrderId,
    );
  const currentIssue = resolvePaidOrderRecoveryIssue({
    ledgerIssue: {
      code: paymentFailure?.errorCode ?? ledgerRow.lastErrorCode,
      message: paymentFailure?.reason ?? ledgerRow.lastErrorMessage,
    },
    providerIssue: merchizeOpsRow
      ? {
          code: merchizeOpsRow.lastSyncErrorCode,
          message: merchizeOpsRow.lastSyncErrorMessage,
        }
      : null,
    providerIssueIsCurrent: Boolean(
      merchizeOpsRow && merchizeOpsRow.updatedAt.getTime() >= ledgerRow.updatedAt.getTime(),
    ),
  });

  return {
    orderToken: ledgerRow.orderToken,
    paypalOrderId: ledgerRow.paypalOrderId,
    djangoOrderIntentUuid: ledgerRow.djangoOrderIntentUuid,
    djangoOrderIntentOrderId: ledgerRow.djangoOrderIntentOrderId,
    djangoPaymentSaveCustomId: ledgerRow.djangoPaymentSaveCustomId,
    userId: ledgerRow.userId,
    customerEmail: ledgerRow.customerEmail.trim().toLowerCase() || ledgerRow.customerEmail,
    customerName: ledgerRow.customerName,
    paypalLedgerStatus: ledgerRow.status,
    adminRecoveryStatus,
    customerRecoveryStatus: getCustomerRecoveryStatus({
      isPaid,
      isResolved,
      isCustomerProtectionVisible,
    }),
    isPaid,
    isQueueVisible,
    isCustomerProtectionVisible,
    isResolved,
    needsProviderDetailSync: providerDetailSyncNeeded,
    needsAdminAttention:
      Boolean(paymentFailure) ||
      ['failed', 'attention', 'sync'].includes(adminRecoveryStatus),
    canRetryFullPostProcessing:
      isPaid &&
      paymentSafeForPostProcessing &&
      !isResolved &&
      !providerDetailSyncNeeded &&
      FULL_POST_PROCESSING_RETRY_STATUSES.has(ledgerRow.status),
    canRetryFulfillment:
      isPaid &&
      paymentSafeForPostProcessing &&
      !isResolved &&
      !providerDetailSyncNeeded &&
      FULFILLMENT_RETRY_STATUSES.has(ledgerRow.status),
    canSyncProviderDetails: paymentSafeForPostProcessing && providerDetailSyncNeeded,
    merchizeExternalOrderNumber,
    merchizeOrderId: merchizeOpsRow?.merchizeOrderId ?? ledgerRow.merchizeProviderOrderId,
    merchizeOrderCode: merchizeOpsRow?.merchizeOrderCode ?? ledgerRow.merchizeProviderOrderCode,
    merchizeOpsSyncStatus: merchizeOpsRow?.syncStatus,
    merchizeProductionGateStatus: merchizeOpsRow?.productionGateStatus,
    merchizeProgressStatus: merchizeOpsRow?.progressStatus,
    merchizeDeliveryStatus: merchizeOpsRow?.deliveryStatus,
    receiptLink: ledgerRow.receiptLink,
    receiptFile: ledgerRow.receiptFile,
    // This projection field is rendered as "Paid" in customer/admin recovery surfaces, so it is
    // populated only from completed PayPal capture evidence.
    paidAmountLabel: paymentState.captureCompletion.ok
      ? getCaptureAmountLabel(ledgerRow.capturePayload, ledgerRow.initialCurrency)
      : null,
    processingSourceLabel: processingSource.label,
    processingSourceTone: processingSource.tone,
    checkoutSurfaceHost: ledgerRow.checkoutSurfaceHost,
    checkoutSurfaceLabel: ledgerRow.checkoutSurfaceLabel,
    latestWebhookSourceLabel,
    latestWebhookEventType: webhookRow?.eventType ?? null,
    latestWebhookProcessingStatus: webhookRow?.processingStatus ?? null,
    lastErrorCode: currentIssue.code,
    lastErrorMessage: currentIssue.message,
    recoveryReason: getRecoveryReason({
      adminRecoveryStatus,
      lastErrorCode: currentIssue.code,
      lastErrorMessage: currentIssue.message,
      merchizeOpsSyncStatus: merchizeOpsRow?.syncStatus,
      merchizeOpsLastSyncErrorCode: merchizeOpsRow?.lastSyncErrorCode,
    }),
    recoveryStage: getRecoveryStage(adminRecoveryStatus, ledgerRow.status),
    recoverySeverity: getRecoverySeverity(adminRecoveryStatus),
    paypalIntentUpdatedAt: ledgerRow.updatedAt,
    merchizeOpsUpdatedAt: merchizeOpsRow?.updatedAt ?? null,
    projectedAt: new Date(),
  };
}

export async function refreshPaidOrderRecoveryProjection(
  orderToken: string,
): Promise<PaidOrderRecoveryProjectionRefreshResult> {
  const normalizedOrderToken = orderToken.trim();
  if (!normalizedOrderToken) {
    return { ok: false, orderToken, reason: 'missing_order_token' };
  }

  const ledgerRow = await getProjectionLedgerRow(normalizedOrderToken);
  if (!ledgerRow) {
    await paypalTxLedger.paidOrderRecoveryProjection
      .delete({ where: { orderToken: normalizedOrderToken } })
      .catch(() => undefined);

    return { ok: false, orderToken: normalizedOrderToken, reason: 'ledger_row_not_found' };
  }

  const [merchizeOpsRow, webhookRow] = await Promise.all([
    getProjectionMerchizeOpsRow(normalizedOrderToken),
    getProjectionWebhookRow(ledgerRow),
  ]);
  const projection = buildProjectionData({ ledgerRow, merchizeOpsRow, webhookRow });

  await paypalTxLedger.paidOrderRecoveryProjection.upsert({
    where: { orderToken: normalizedOrderToken },
    create: projection,
    update: projection,
  });

  return {
    ok: true,
    orderToken: normalizedOrderToken,
    adminRecoveryStatus: projection.adminRecoveryStatus as AdminRecoveryStatus,
    isQueueVisible: Boolean(projection.isQueueVisible),
    isCustomerProtectionVisible: Boolean(projection.isCustomerProtectionVisible),
  };
}

export async function refreshPaidOrderRecoveryProjectionSafely(orderToken: string) {
  try {
    return await refreshPaidOrderRecoveryProjection(orderToken);
  } catch (error) {
    console.error('[paid_order_recovery_projection.refresh_failed]', {
      orderToken,
      error: safeLogErrorMessage(error),
    });

    return {
      ok: false as const,
      orderToken,
      reason: safeLogErrorMessage(error),
    };
  }
}

export async function refreshPaidOrderRecoveryProjections(orderTokens: string[]) {
  const uniqueOrderTokens = [...new Set(orderTokens.map((token) => token.trim()).filter(Boolean))];

  return Promise.all(uniqueOrderTokens.map(refreshPaidOrderRecoveryProjectionSafely));
}

export async function backfillPaidOrderRecoveryProjections({
  batchSize = 100,
  cursorOrderToken,
  dryRun = false,
  orderTokens,
}: {
  batchSize?: number;
  cursorOrderToken?: string | null;
  dryRun?: boolean;
  orderTokens?: string[];
} = {}): Promise<PaidOrderRecoveryProjectionBackfillResult> {
  const normalizedBatchSize = Math.min(Math.max(Math.floor(batchSize), 1), 250);
  const rows = await paypalTxLedger.paypalIntent.findMany({
    where: {
      ...(orderTokens?.length ? { orderToken: { in: orderTokens } } : {}),
      status: {
        in: [...ADMIN_RECOVERY_LEDGER_STATUSES],
      },
    },
    ...(cursorOrderToken && !orderTokens?.length
      ? {
          cursor: {
            orderToken: cursorOrderToken,
          },
          skip: 1,
        }
      : {}),
    orderBy: [{ updatedAt: 'desc' }, { orderToken: 'asc' }],
    take: normalizedBatchSize,
    select: {
      orderToken: true,
    },
  });
  const result: PaidOrderRecoveryProjectionBackfillResult = {
    ok: true,
    dryRun,
    scanned: rows.length,
    refreshed: 0,
    skipped: 0,
    nextCursorOrderToken:
      rows.length === normalizedBatchSize ? (rows.at(-1)?.orderToken ?? null) : null,
    orderTokens: rows.map((row) => row.orderToken),
    errors: [],
  };

  if (dryRun) return result;

  for (const row of rows) {
    const refresh = await refreshPaidOrderRecoveryProjectionSafely(row.orderToken);
    if (refresh.ok) {
      result.refreshed += 1;
    } else {
      result.ok = false;
      result.skipped += 1;
      result.errors.push({ orderToken: row.orderToken, error: refresh.reason });
    }
  }

  return result;
}
