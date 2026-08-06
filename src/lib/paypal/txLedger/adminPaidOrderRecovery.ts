import 'server-only';

import { formatDistanceToNowStrict } from 'date-fns';

import { formatAdminSystemTimestamp } from '@/lib/admin/formatAdminSystemTimestamp';
import { getRecoveryScannerMinAgeMinutes } from '@/lib/paypal/txLedger/processingPolicy';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { listCustomerNotificationsForOrder } from '@/lib/paypal/txLedger/customerNotificationOutbox';
import {
  getPayPalLedgerInferredProcessingSourceDisplay,
  getPayPalLedgerProcessingSourceDisplay,
  getPayPalLedgerRunnerSourceLabel,
} from '@/lib/paypal/txLedger/paypalLedgerProvenance';
import {
  getMerchizeFulfillmentOpsPrisma,
  isMerchizeFulfillmentOpsDatabaseConfigured,
} from '@/lib/prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOpsPrisma';
import {
  MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS,
  MERCHIZE_FULFILLMENT_SYNC_STATUS,
} from '@/lib/merchizeFulfillmentOps/status';
import { isMerchizeLookupPendingProviderProcessingError } from '@/lib/merchizeFulfillmentOps/lookupPending';
import { safeLogErrorMessage } from '@/lib/merchizeFulfillmentOps/redaction';
import { isAcceptedDjangoFulfillmentProcessResponse } from '@/lib/paypal/txLedger/fulfillmentProcessResponse';
import { getMerchizeFulfillmentRetryEligibility } from '@/lib/paypal/txLedger/fulfillmentRetryPolicy';
import { resolvePaidOrderRecoveryIssue } from '@/lib/paypal/txLedger/recoveryIssuePrecedence';
import { extractMerchizeExternalOrderNumberFromDjangoProcessResponse } from '@/lib/merchizeFulfillmentOps/merchizeMapper';
import {
  parseCanonicalOrderSnapshotFromLedger,
  type CanonicalOrderSnapshotLedgerEnvelope,
} from '@/lib/paypal/orderSnapshot/canonicalize';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';
import type { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';
import type {
  MerchizeFulfillmentOpsAdminSummary,
  PaidOrderRecoveryActivityItem,
  PaidOrderRecoveryAddress,
  PaidOrderRecoveryDetail,
  PaidOrderRecoveryFilters,
  PaidOrderRecoveryLineItem,
  PaidOrderRecoveryListResult,
  PaidOrderRecoveryPagination,
  PaidOrderRecoveryRow,
  PaidOrderRecoveryStatusFilter,
  PaidOrderRecoveryWebhookEvent,
  TimelineItem,
} from '@/components/UI/Admin/dashboard/adminShopDashboardTypes';

type JsonRecord = Record<string, unknown>;
const SCANNER_RECOVERABLE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
]);
const DEFAULT_ADMIN_RECOVERY_PAGE_SIZE = 25;
const ADMIN_RECOVERY_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const ADMIN_RECOVERY_STATUS_FILTERS = new Set<PaidOrderRecoveryStatusFilter>([
  'all',
  'failed',
  'recovery',
  'pending',
  'completed',
  'sync',
  'attention',
]);

export type ListAdminPaidOrderRecoveryRowsArgs = {
  filters?: Partial<PaidOrderRecoveryFilters>;
  page?: number;
  pageSize?: number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
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

function needsProviderDetailSync(payload: unknown, merchizeOpsSyncStatus?: string | null) {
  const detailOrPushSyncedStatuses = new Set<string>([
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

  return (
    isAcceptedDjangoFulfillmentProcessResponse(payload) &&
    !detailOrPushSyncedStatuses.has(merchizeOpsSyncStatus ?? '')
  );
}

function getMerchizeOrderCodeFromFulfillmentResponse(payload: unknown) {
  return (
    asString(getPath(payload, ['data', 'response_data', 'data', 'data', 'order_id'])) ??
    asString(getPath(payload, ['response_data', 'data', 'data', 'order_id']))
  );
}

function getCaptureAmount(capturePayload: unknown, fallbackCurrency?: string | null) {
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

  return '—';
}

function getRecoveryAmount(
  row: {
    capturePayload: unknown;
    initialCurrency: string | null;
  },
) {
  return getCaptureAmount(row.capturePayload, row.initialCurrency);
}

function mapLedgerStatusToAdminStatus(status: string): PaidOrderRecoveryRow['status'] {
  if (status === PAYPAL_LEDGER_STATUS.COMPLETED) return 'completed';
  if (
    status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED ||
    status === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED ||
    status === PAYPAL_LEDGER_STATUS.ERROR
  ) {
    return 'failed';
  }
  if (status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED) return 'attention';
  if (
    status === PAYPAL_LEDGER_STATUS.CAPTURED ||
    status === PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED
  ) {
    return 'recovery';
  }
  return 'pending';
}

function normalizeRecoveryStatusFilter(
  status: string | null | undefined,
): PaidOrderRecoveryStatusFilter {
  const normalized = status?.trim() as PaidOrderRecoveryStatusFilter | undefined;

  return normalized && ADMIN_RECOVERY_STATUS_FILTERS.has(normalized) ? normalized : 'all';
}

function normalizeRecoverySearch(search: string | null | undefined) {
  return search?.trim().slice(0, 160) ?? '';
}

export function normalizePaidOrderRecoveryFilters(
  filters: {
    search?: string | null;
    status?: string | null;
  } = {},
): PaidOrderRecoveryFilters {
  return {
    search: normalizeRecoverySearch(filters.search),
    status: normalizeRecoveryStatusFilter(filters.status),
  };
}

export function getPaidOrderRecoveryPageSize(value: unknown) {
  const pageSize = Number(value);

  return ADMIN_RECOVERY_PAGE_SIZE_OPTIONS.includes(
    pageSize as (typeof ADMIN_RECOVERY_PAGE_SIZE_OPTIONS)[number],
  )
    ? pageSize
    : DEFAULT_ADMIN_RECOVERY_PAGE_SIZE;
}

export function getPaidOrderRecoveryPage(value: unknown) {
  const page = Number(value);

  return Number.isInteger(page) && page > 0 ? page : 1;
}

function buildPaidOrderRecoveryWhere(filters: PaidOrderRecoveryFilters) {
  const where: Prisma.PaidOrderRecoveryProjectionWhereInput = {
    isQueueVisible: true,
  };

  if (filters.status !== 'all') where.adminRecoveryStatus = filters.status;

  if (filters.search) {
    const search = filters.search;
    where.OR = [
      { orderToken: { contains: search } },
      { customerEmail: { contains: search } },
      { customerName: { contains: search } },
      { paypalOrderId: { contains: search } },
      { djangoOrderIntentOrderId: { contains: search } },
      { djangoPaymentSaveCustomId: { contains: search } },
      { merchizeExternalOrderNumber: { contains: search } },
      { merchizeOrderId: { contains: search } },
      { merchizeOrderCode: { contains: search } },
      { lastErrorCode: { contains: search } },
      { lastErrorMessage: { contains: search } },
      { recoveryReason: { contains: search } },
    ];
  }

  return where;
}

function buildPaidOrderRecoveryPagination({
  currentPage,
  pageSize,
  totalRows,
}: {
  currentPage: number;
  pageSize: number;
  totalRows: number;
}): PaidOrderRecoveryPagination {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const boundedPage = Math.min(currentPage, totalPages);

  return {
    currentPage: boundedPage,
    pageSize,
    totalRows,
    totalPages,
    pageStart: totalRows ? (boundedPage - 1) * pageSize + 1 : 0,
    pageEnd: Math.min(boundedPage * pageSize, totalRows),
  };
}

function getStepLabel(status: string) {
  if (status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED) return 'Fulfillment Blocked';
  if (status === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED) return 'Fulfillment Failed';
  if (status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED)
    return 'Fulfillment Attention Required';
  if (status === PAYPAL_LEDGER_STATUS.PAYMENT_SAVED) return 'Payment Saved';
  if (status === PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED) return 'Receipt Prepared';
  if (status === PAYPAL_LEDGER_STATUS.CAPTURED) return 'Payment Captured';
  if (status === PAYPAL_LEDGER_STATUS.COMPLETED) return 'Completed';
  if (status === PAYPAL_LEDGER_STATUS.ERROR) return 'Post-processing Error';
  return 'In Progress';
}

function getErrorLabel(errorCode: string | null, errorMessage: string | null) {
  if (!errorCode && !errorMessage) return '—';
  if (errorCode === 'FULFILLMENT_PAYLOAD_INVALID') return 'Payload Validation Failed';
  if (errorCode === 'FULFILLMENT_PROVIDER_REJECTED') return 'Provider Rejected Fulfillment';
  if (isMerchizeLookupPendingProviderProcessingError(errorCode)) return 'Provider Lookup Pending';
  if (errorCode === 'MERCHIZE_PUSH_DISABLED_BY_CONFIG') return 'Push Disabled by Config';
  if (errorCode === 'POST_PROCESSING_FAILED') return 'Post-processing Failed';
  return errorMessage ?? errorCode ?? 'Unknown error';
}

function getProviderDetailSyncMessage(args: {
  syncStatus?: string | null;
  lastSyncErrorCode?: string | null;
}) {
  if (isMerchizeLookupPendingProviderProcessingError(args.lastSyncErrorCode)) {
    return 'Merchize is still indexing the accepted order; scanner/admin retry will resume sync.';
  }

  if (args.syncStatus === MERCHIZE_FULFILLMENT_SYNC_STATUS.LOOKUP_PENDING) {
    return 'Fulfillment accepted; provider lookup is pending.';
  }

  return 'Fulfillment accepted; sync provider details';
}

function formatUpdated(date: Date) {
  return `${formatDistanceToNowStrict(date, { addSuffix: true })}`;
}

function mapLedgerRowToPaidOrderRecoveryRow(
  row: CanonicalOrderSnapshotLedgerEnvelope & {
    orderToken: string;
    customerEmail: string;
    customerName: string;
    status: string;
    capturePayload: unknown;
    initialCurrency: string | null;
    merchizeFulfillmentResponsePayload: unknown;
    merchizeFulfillmentOpsSyncStatus?: string | null;
    merchizeFulfillmentOpsLastSyncErrorCode?: string | null;
    merchizeFulfillmentOpsPrimaryBlocker?: {
      code: string;
      message: string;
    } | null;
    latestWebhookSourceLabel?: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    processingTriggerDetail?: string | null;
    processingTriggeredAt?: Date | null;
    processingTriggerSource?: string | null;
    checkoutSurfaceLabel?: string | null;
    updatedAt: Date;
  },
): PaidOrderRecoveryRow {
  const providerDetailSyncNeeded = needsProviderDetailSync(
    row.merchizeFulfillmentResponsePayload,
    row.merchizeFulfillmentOpsSyncStatus,
  );
  const processingSource = getPayPalLedgerProcessingSourceDisplay(
    row,
    getPayPalLedgerInferredProcessingSourceDisplay({
      checkoutSurfaceLabel: row.checkoutSurfaceLabel,
      hasCapturePayload: Boolean(row.capturePayload),
      ledgerStatus: row.status,
    }) ?? undefined,
  );
  const currentIssue = resolvePaidOrderRecoveryIssue({
    ledgerIssue: {
      code: row.lastErrorCode,
      message: row.lastErrorMessage,
    },
    providerIssue: row.merchizeFulfillmentOpsPrimaryBlocker ?? null,
    providerIssueIsCurrent: true,
  });

  return {
    orderToken: row.orderToken,
    status: providerDetailSyncNeeded ? 'sync' : mapLedgerStatusToAdminStatus(row.status),
    customer: row.customerEmail || row.customerName,
    amount: getRecoveryAmount(row),
    step: providerDetailSyncNeeded ? 'Provider Detail Sync' : getStepLabel(row.status),
    error: providerDetailSyncNeeded
      ? getProviderDetailSyncMessage({
          syncStatus: row.merchizeFulfillmentOpsSyncStatus,
          lastSyncErrorCode: row.merchizeFulfillmentOpsLastSyncErrorCode,
        })
      : getErrorLabel(currentIssue.code, currentIssue.message),
    processingSourceLabel: processingSource.label,
    processingSourceTone: processingSource.tone,
    supportRef: row.orderToken.slice(0, 8).toUpperCase(),
    updated: formatUpdated(row.updatedAt),
    needsProviderDetailSync: providerDetailSyncNeeded,
  };
}

function mapProjectionRowToPaidOrderRecoveryRow(row: {
  orderToken: string;
  adminRecoveryStatus: string;
  customerEmail: string;
  customerName: string;
  paidAmountLabel: string | null;
  recoveryStage: string | null;
  recoveryReason: string | null;
  processingSourceLabel: string | null;
  processingSourceTone: string | null;
  paypalIntentUpdatedAt: Date | null;
  updatedAt: Date;
  needsProviderDetailSync: boolean;
}): PaidOrderRecoveryRow {
  const status = normalizeRecoveryStatusFilter(row.adminRecoveryStatus);

  return {
    orderToken: row.orderToken,
    status: status === 'all' ? 'pending' : status,
    customer: row.customerEmail || row.customerName,
    amount: row.paidAmountLabel ?? '—',
    step: row.recoveryStage ?? 'In Progress',
    error: row.recoveryReason ?? '—',
    processingSourceLabel: row.processingSourceLabel ?? 'Not recorded',
    processingSourceTone:
      row.processingSourceTone === 'cyan' ||
      row.processingSourceTone === 'emerald' ||
      row.processingSourceTone === 'amber' ||
      row.processingSourceTone === 'rose' ||
      row.processingSourceTone === 'slate'
        ? row.processingSourceTone
        : 'slate',
    supportRef: row.orderToken.slice(0, 8).toUpperCase(),
    updated: formatUpdated(row.paypalIntentUpdatedAt ?? row.updatedAt),
    needsProviderDetailSync: row.needsProviderDetailSync,
  };
}

function buildTimeline(row: {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  processingCompletedAt: Date | null;
  receiptLink: string | null;
  receiptFile: string | null;
  djangoPaymentSaveCustomId: string | null;
  lastErrorCode: string | null;
  merchizeFulfillmentResponsePayload: unknown;
  merchizeFulfillmentOpsSyncStatus?: string | null;
  merchizeFulfillmentOpsLastDetailSyncAt?: string | null;
  merchizeFulfillmentOpsProductionGateStatus?: string | null;
  merchizeFulfillmentOpsReleasedToProductionAt?: string | null;
}) {
  const created = formatTimelineDate(row.createdAt);
  const updated = formatTimelineDate(row.updatedAt);
  const completed = row.processingCompletedAt
    ? formatTimelineDate(row.processingCompletedAt)
    : 'Pending';

  const items: TimelineItem[] = [
    { label: 'Payment Ledger Created', time: created, state: 'done' },
    {
      label: 'Receipt Prepared',
      time: row.receiptLink ? 'Time not recorded' : 'Pending',
      state: row.receiptLink ? 'done' : 'pending',
    },
    {
      label: 'Payment Saved to Django',
      time: row.djangoPaymentSaveCustomId ? 'Time not recorded' : 'Pending',
      state: row.djangoPaymentSaveCustomId ? 'done' : 'pending',
    },
  ];

  if (
    needsProviderDetailSync(
      row.merchizeFulfillmentResponsePayload,
      row.merchizeFulfillmentOpsSyncStatus,
    )
  ) {
    items.push({
      label: 'Fulfillment Accepted; Provider Details Pending',
      time: updated,
      state: 'pending',
    });
  } else if (
    row.merchizeFulfillmentOpsProductionGateStatus ===
    MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_VERIFIED
  ) {
    items.push({
      label: 'Merchize Push Verified',
      time: row.merchizeFulfillmentOpsReleasedToProductionAt ?? completed,
      state: 'done',
    });
  } else if (
    row.merchizeFulfillmentOpsProductionGateStatus ===
      MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_ACKNOWLEDGED ||
    row.merchizeFulfillmentOpsProductionGateStatus ===
      MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_VERIFICATION_PENDING
  ) {
    items.push({
      label: 'Merchize Push Awaiting Verification',
      time: updated,
      state: 'pending',
    });
  } else if (
    row.merchizeFulfillmentOpsProductionGateStatus ===
    MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_FAILED
  ) {
    items.push({
      label: 'Merchize Push Failed',
      time: updated,
      state: 'failed',
    });
  } else if (
    row.merchizeFulfillmentOpsProductionGateStatus ===
    MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_DISABLED
  ) {
    items.push({
      label: 'Merchize Push Disabled by Config',
      time: updated,
      state: 'pending',
    });
  } else if (
    row.merchizeFulfillmentOpsSyncStatus === MERCHIZE_FULFILLMENT_SYNC_STATUS.DETAIL_SYNCED
  ) {
    items.push({
      label: 'Merchize Provider Details Synced',
      time: row.merchizeFulfillmentOpsLastDetailSyncAt ?? updated,
      state: 'done',
    });
  } else if (
    row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED ||
    row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED ||
    row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED ||
    row.status === PAYPAL_LEDGER_STATUS.ERROR
  ) {
    items.push({
      label:
        row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED
          ? 'Fulfillment Blocked'
          : row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED
            ? 'Fulfillment Failed'
            : row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED
              ? 'Fulfillment Attention Required'
              : 'Post-processing Failed',
      time: updated,
      state: 'failed',
    });
  } else if (row.status === PAYPAL_LEDGER_STATUS.COMPLETED) {
    items.push({ label: 'Fulfillment Completed', time: completed, state: 'done' });
  } else {
    items.push({ label: 'Fulfillment Pending', time: 'Pending', state: 'pending' });
  }

  return items;
}

function formatTimelineDate(date: Date) {
  return formatAdminSystemTimestamp(date, { includeYear: false }) ?? '—';
}

function formatLongDate(date: Date | null | undefined) {
  return formatAdminSystemTimestamp(date) ?? '—';
}

function getStoredReadinessSummary(payload: unknown) {
  const record = asRecord(payload);
  const addressReadbackMismatchFields = Array.isArray(record?.addressReadbackMismatchFields)
    ? record.addressReadbackMismatchFields.filter(
        (value): value is string =>
          typeof value === 'string' &&
          ['line1', 'line2', 'city', 'state', 'postalCode', 'countryCode'].includes(value),
      )
    : [];
  const blockers = Array.isArray(record?.blockers)
    ? record.blockers.flatMap((value) => {
        const blocker = asRecord(value);
        const code = asString(blocker?.code);
        const message = asString(blocker?.message);
        const category = asString(blocker?.category);

        return code && message && category
          ? [
              {
                code,
                message,
                category,
                retryable: blocker?.retryable === true,
              },
            ]
          : [];
      })
    : [];

  return {
    status: asString(record?.status),
    blockers,
    addressValidationStatus: asString(record?.addressValidationStatus),
    addressMarkedValid: record?.addressMarkedValid === true,
    addressReadbackStatus: asString(record?.addressReadbackStatus),
    addressReadbackMismatchFields,
  };
}

function mapMerchizeFulfillmentOpsSummary(row: {
  syncStatus: string;
  productionGateStatus: string | null;
  merchizeExternalOrderNumber: string;
  merchizeOrderId: string | null;
  merchizeStatus: string | null;
  addressReviewStatus: string | null;
  itemReviewStatus: string | null;
  artworkReviewStatus: string | null;
  progressStatus: string | null;
  deliveryStatus: string | null;
  costReviewStatus: string | null;
  attentionReviewStatus: string | null;
  providerPushProgress: string | null;
  manualReleaseRequired: boolean;
  itemCount: number;
  releasedToProductionAt: Date | null;
  pushAcknowledgedAt: Date | null;
  pushVerifiedAt: Date | null;
  providerAddressUpdatedAt: Date | null;
  lastReadinessCheckAt: Date | null;
  lastAddressCheckAt: Date | null;
  lastCostCheckAt: Date | null;
  lastLookupAt: Date | null;
  lastDetailSyncAt: Date | null;
  lastProgressSyncAt: Date | null;
  lastTrackingSyncAt: Date | null;
  lastHistorySyncAt: Date | null;
  lastTicketSyncAt: Date | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorMessage: string | null;
  merchizeProductionReadinessPayload: unknown;
}): MerchizeFulfillmentOpsAdminSummary {
  const readiness = getStoredReadinessSummary(row.merchizeProductionReadinessPayload);

  return {
    syncStatus: row.syncStatus,
    productionGateStatus: row.productionGateStatus,
    readinessStatus: readiness.status,
    readinessBlockers: readiness.blockers,
    merchizeExternalOrderNumber: row.merchizeExternalOrderNumber,
    merchizeOrderId: row.merchizeOrderId,
    merchizeStatus: row.merchizeStatus,
    addressValidationStatus: readiness.addressValidationStatus,
    addressMarkedValid: readiness.addressMarkedValid,
    addressReadbackStatus: readiness.addressReadbackStatus,
    addressReadbackMismatchFields: readiness.addressReadbackMismatchFields,
    addressReviewStatus: row.addressReviewStatus,
    itemReviewStatus: row.itemReviewStatus,
    artworkReviewStatus: row.artworkReviewStatus,
    progressStatus: row.progressStatus,
    deliveryStatus: row.deliveryStatus,
    costReviewStatus: row.costReviewStatus,
    attentionReviewStatus: row.attentionReviewStatus,
    providerPushProgress: row.providerPushProgress,
    manualReleaseRequired: row.manualReleaseRequired,
    itemCount: row.itemCount,
    releasedToProductionAt: row.releasedToProductionAt
      ? formatLongDate(row.releasedToProductionAt)
      : null,
    pushAcknowledgedAt: row.pushAcknowledgedAt ? formatLongDate(row.pushAcknowledgedAt) : null,
    pushVerifiedAt: row.pushVerifiedAt ? formatLongDate(row.pushVerifiedAt) : null,
    providerAddressUpdatedAt: row.providerAddressUpdatedAt
      ? formatLongDate(row.providerAddressUpdatedAt)
      : null,
    lastReadinessCheckAt: row.lastReadinessCheckAt
      ? formatLongDate(row.lastReadinessCheckAt)
      : null,
    lastAddressCheckAt: row.lastAddressCheckAt ? formatLongDate(row.lastAddressCheckAt) : null,
    lastCostCheckAt: row.lastCostCheckAt ? formatLongDate(row.lastCostCheckAt) : null,
    lastLookupAt: row.lastLookupAt ? formatLongDate(row.lastLookupAt) : null,
    lastDetailSyncAt: row.lastDetailSyncAt ? formatLongDate(row.lastDetailSyncAt) : null,
    lastProgressSyncAt: row.lastProgressSyncAt ? formatLongDate(row.lastProgressSyncAt) : null,
    lastTrackingSyncAt: row.lastTrackingSyncAt ? formatLongDate(row.lastTrackingSyncAt) : null,
    lastHistorySyncAt: row.lastHistorySyncAt ? formatLongDate(row.lastHistorySyncAt) : null,
    lastTicketSyncAt: row.lastTicketSyncAt ? formatLongDate(row.lastTicketSyncAt) : null,
    lastSyncErrorCode: row.lastSyncErrorCode,
    lastSyncErrorMessage: row.lastSyncErrorMessage,
  };
}

async function getMerchizeFulfillmentOpsSummaries(orderTokens: string[]) {
  const summaries = new Map<string, MerchizeFulfillmentOpsAdminSummary>();
  if (!orderTokens.length || !isMerchizeFulfillmentOpsDatabaseConfigured()) {
    return summaries;
  }

  try {
    const prisma = getMerchizeFulfillmentOpsPrisma();
    const rows = await prisma.merchizeFulfillmentOrder.findMany({
      where: { orderToken: { in: orderTokens } },
      orderBy: { updatedAt: 'desc' },
      select: {
        orderToken: true,
        syncStatus: true,
        productionGateStatus: true,
        merchizeExternalOrderNumber: true,
        merchizeOrderId: true,
        merchizeStatus: true,
        addressReviewStatus: true,
        itemReviewStatus: true,
        artworkReviewStatus: true,
        progressStatus: true,
        deliveryStatus: true,
        costReviewStatus: true,
        attentionReviewStatus: true,
        providerPushProgress: true,
        manualReleaseRequired: true,
        itemCount: true,
        releasedToProductionAt: true,
        pushAcknowledgedAt: true,
        pushVerifiedAt: true,
        providerAddressUpdatedAt: true,
        lastReadinessCheckAt: true,
        lastAddressCheckAt: true,
        lastCostCheckAt: true,
        lastLookupAt: true,
        lastDetailSyncAt: true,
        lastProgressSyncAt: true,
        lastTrackingSyncAt: true,
        lastHistorySyncAt: true,
        lastTicketSyncAt: true,
        lastSyncErrorCode: true,
        lastSyncErrorMessage: true,
        merchizeProductionReadinessPayload: true,
      },
    });

    for (const row of rows) {
      if (!summaries.has(row.orderToken)) {
        summaries.set(row.orderToken, mapMerchizeFulfillmentOpsSummary(row));
      }
    }
  } catch (error) {
    console.error('[merchize.fulfillment_ops.admin_summary_failed]', {
      error: safeLogErrorMessage(error),
    });
  }

  return summaries;
}

function normalizeAddress(value: unknown): PaidOrderRecoveryAddress | null {
  const address = asRecord(value);

  if (!address) return null;

  const normalized = {
    line1: asString(address.shipping_address_line_1) ?? '',
    line2: asString(address.shipping_address_line_2) ?? '',
    city: asString(address.shipping_city) ?? '',
    state: asString(address.shipping_state) ?? '',
    postalCode: asString(address.zip_code) ?? '',
    country: asString(address.shipping_country) ?? '',
  };

  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function getLegacyCartItems(
  cartSnapshot: unknown,
  currency: string | null,
): PaidOrderRecoveryLineItem[] {
  if (!Array.isArray(cartSnapshot)) return [];

  return cartSnapshot.map((item, index) => {
    const record = asRecord(item);
    const itemDetail = asRecord(record?.itemDetail);
    const options = Array.isArray(itemDetail?.options) ? itemDetail.options : [];
    const variant = options
      .map((option) => {
        const optionRecord = asRecord(option);
        return asString(optionRecord?.value) ?? asString(optionRecord?.name);
      })
      .filter(Boolean)
      .join(' / ');
    const unitPrice = asNumber(itemDetail?.retail_price) ?? 0;

    return {
      id: asString(record?.variantId) ?? `item-${index}`,
      title: asString(record?.title) ?? asString(itemDetail?.title) ?? 'Untitled item',
      variant:
        variant || asString(itemDetail?.sku) || asString(itemDetail?.sku_seller) || 'Standard',
      quantity: asNumber(record?.quantity) ?? 1,
      unitPrice: formatCurrency(unitPrice, currency),
      image:
        asString(itemDetail?.image) ??
        (Array.isArray(itemDetail?.image_uris) ? asString(itemDetail.image_uris[0]) : null),
    };
  });
}

function getCanonicalOrderItems(snapshot: CanonicalOrderSnapshot): PaidOrderRecoveryLineItem[] {
  return snapshot.lines.map((line) => {
    const variant = line.selectedOptions
      .map((option) => `${option.name}: ${option.value}`)
      .join(' / ');

    return {
      id: line.lineId,
      title: line.title,
      variant: variant || line.sellerSku || line.sku,
      quantity: line.quantity,
      unitPrice: formatCurrency(Number(line.unitAmount.value), snapshot.currency),
      image: line.imageUrl || null,
    };
  });
}

function getRecoveryOrderItems(
  row: CanonicalOrderSnapshotLedgerEnvelope & {
    cartSnapshot: unknown;
    initialCurrency: string | null;
  },
) {
  let parsedSnapshot;
  try {
    parsedSnapshot = parseCanonicalOrderSnapshotFromLedger(row);
  } catch {
    // Keep corrupt canonical rows inspectable as payment incidents, but never restore mutable cart
    // data as order truth. The payment-chain evidence exposes the corruption reason separately.
    return [];
  }

  return parsedSnapshot.snapshot
    ? getCanonicalOrderItems(parsedSnapshot.snapshot)
    : getLegacyCartItems(row.cartSnapshot, row.initialCurrency);
}

function formatCurrency(value: number, currency: string | null) {
  if (!currency) return value.toFixed(2);

  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function buildActivity(row: {
  createdAt: Date;
  updatedAt: Date;
  receiptLink: string | null;
  djangoPaymentSaveCustomId: string | null;
  fulfillmentAddressOverriddenAt: Date | null;
  fulfillmentAddressOverrideReason: string | null;
  processingCompletedAt: Date | null;
  processingTriggeredAt?: Date | null;
  processingTriggerDetail?: string | null;
  processingTriggerSource?: string | null;
  status: string;
  lastErrorMessage: string | null;
  webhookEvents: PaidOrderRecoveryWebhookEvent[];
}): PaidOrderRecoveryActivityItem[] {
  type DatedActivityItem = PaidOrderRecoveryActivityItem & { sortAt: number };

  const activity: DatedActivityItem[] = [
    {
      label: 'Ledger created',
      description: 'Paid checkout entered the post-payment ledger.',
      time: formatLongDate(row.createdAt),
      tone: 'slate',
      kind: 'system',
      sortAt: row.createdAt.getTime(),
    },
  ];

  if (row.receiptLink) {
    activity.push({
      label: 'Receipt prepared',
      description: 'Customer receipt was generated and attached to the order record.',
      time: 'Time not recorded',
      tone: 'cyan',
      kind: 'system',
      sortAt: Number.NEGATIVE_INFINITY,
    });
  }

  const latestWebhook = row.webhookEvents[0];
  if (latestWebhook) {
    const webhookFailed = latestWebhook.processingStatus === 'failed';
    const laterCompleted = webhookFailed && Boolean(row.processingCompletedAt);

    activity.push({
      label: webhookFailed ? 'Webhook processing failed' : 'Webhook observed',
      description: `${latestWebhook.eventType} webhook delivery is ${latestWebhook.processingStatus}.${
        laterCompleted ? ' Ledger processing later completed successfully.' : ''
      }`,
      time: latestWebhook.processedAt ?? latestWebhook.lastAttemptAt ?? latestWebhook.createdAt,
      tone: latestWebhook.processingStatus === 'processed' ? 'emerald' : 'amber',
      kind: 'system',
      sortAt: latestWebhook.occurredAtMs,
    });
  }

  if (row.processingTriggerSource && row.processingTriggeredAt) {
    activity.push({
      label: 'Processing runner selected',
      description: `${getPayPalLedgerRunnerSourceLabel(row.processingTriggerSource)} resumed post-payment processing${
        row.processingTriggerDetail ? ` (${row.processingTriggerDetail})` : ''
      }.`,
      time: formatLongDate(row.processingTriggeredAt),
      tone: row.processingTriggerSource === 'webhook' ? 'cyan' : 'amber',
      kind: row.processingTriggerSource === 'manual_admin' ? 'operator' : 'system',
      sortAt: row.processingTriggeredAt.getTime(),
    });
  }

  if (row.djangoPaymentSaveCustomId) {
    activity.push({
      label: 'Payment saved',
      description: 'The payment was saved to the Django order backend.',
      time: 'Time not recorded',
      tone: 'emerald',
      kind: 'system',
      sortAt: Number.NEGATIVE_INFINITY,
    });
  }

  if (row.fulfillmentAddressOverriddenAt) {
    activity.push({
      label: 'Fulfillment address overridden',
      description:
        row.fulfillmentAddressOverrideReason ?? 'Admin saved a fulfillment address override.',
      time: formatLongDate(row.fulfillmentAddressOverriddenAt),
      tone: 'amber',
      kind: 'operator',
      sortAt: row.fulfillmentAddressOverriddenAt.getTime(),
    });
  }

  if (row.processingCompletedAt) {
    activity.push({
      label: 'Processing completed',
      description: 'The order finished its server-side post-payment flow.',
      time: formatLongDate(row.processingCompletedAt),
      tone: 'emerald',
      kind: 'system',
      sortAt: row.processingCompletedAt.getTime(),
    });
  } else if (row.lastErrorMessage) {
    activity.push({
      label: 'Recovery required',
      description: row.lastErrorMessage,
      time: formatLongDate(row.updatedAt),
      tone:
        row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED ||
        row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED
          ? 'amber'
          : 'rose',
      kind: 'system',
      sortAt: row.updatedAt.getTime(),
    });
  }

  return activity
    .sort((left, right) => right.sortAt - left.sortAt)
    .map((item) => ({
      label: item.label,
      description: item.description,
      time: item.time,
      tone: item.tone,
      kind: item.kind,
    }));
}

function mapWebhookEvent(event: {
  eventId: string;
  eventType: string;
  processingStatus: string;
  attemptCount: number;
  createdAt: Date;
  processedAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorMessage: string | null;
  matchedWebhookBindingKey: string | null;
  matchedWebhookId: string | null;
  matchedWebhookLabel: string | null;
  matchedWebhookSource: string | null;
  orderToken: string | null;
  webhookVerificationMode: string | null;
}): PaidOrderRecoveryWebhookEvent {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    processingStatus: event.processingStatus,
    attemptCount: event.attemptCount,
    createdAt: formatLongDate(event.createdAt),
    processedAt: event.processedAt ? formatLongDate(event.processedAt) : null,
    lastAttemptAt: event.lastAttemptAt ? formatLongDate(event.lastAttemptAt) : null,
    occurredAtMs: (event.processedAt ?? event.lastAttemptAt ?? event.createdAt).getTime(),
    lastErrorMessage: event.lastErrorMessage,
    matchedWebhookBindingKey: event.matchedWebhookBindingKey,
    matchedWebhookId: event.matchedWebhookId,
    matchedWebhookLabel: event.matchedWebhookLabel,
    matchedWebhookSource: event.matchedWebhookSource,
    orderToken: event.orderToken,
    webhookVerificationMode: event.webhookVerificationMode,
  };
}

function getScannerState(
  row: CanonicalOrderSnapshotLedgerEnvelope & {
    status: string;
    authorizePayload: unknown;
    capturePayload: unknown;
    processingCompletedAt: Date | null;
    postProcessingLockExpiresAt: Date | null;
    updatedAt: Date;
  },
) {
  if (row.processingCompletedAt) {
    return { eligible: false, reason: 'Processing is already completed.' };
  }

  if (!SCANNER_RECOVERABLE_STATUSES.has(row.status)) {
    return { eligible: false, reason: `Status ${row.status} is not automatic-scanner eligible.` };
  }

  if (!row.capturePayload) {
    return { eligible: false, reason: 'Capture payload is missing.' };
  }

  const captureCompletion = getPayPalCaptureCompletion(row.capturePayload);
  if (!captureCompletion.ok) {
    return { eligible: false, reason: captureCompletion.reason };
  }

  const paymentChain = reconcileCanonicalPayPalPaymentChain(
    row,
    row.authorizePayload,
    row.capturePayload,
  );
  if (!paymentChain.ok) {
    return { eligible: false, reason: paymentChain.reconciliation.reason };
  }

  if (row.postProcessingLockExpiresAt && row.postProcessingLockExpiresAt > new Date()) {
    return { eligible: false, reason: 'A post-processing lock is active.' };
  }

  const minAgeMinutes = getRecoveryScannerMinAgeMinutes();
  const ageMs = Date.now() - row.updatedAt.getTime();
  if (ageMs < minAgeMinutes * 60_000) {
    return { eligible: false, reason: `Row is newer than ${minAgeMinutes} minutes.` };
  }

  return { eligible: true, reason: 'Eligible for automatic scanner recovery.' };
}

function buildDetail(
  row: CanonicalOrderSnapshotLedgerEnvelope & {
    orderToken: string;
    customerName: string;
    customerEmail: string;
    userId: string | null;
    createdAt: Date;
    updatedAt: Date;
    receiptLink: string | null;
    receiptFile: string | null;
    authorizePayload: unknown;
    capturePayload: unknown;
    shippingSnapshot: unknown;
    fulfillmentAddressOverride: unknown;
    fulfillmentAddressOverrideReason: string | null;
    fulfillmentAddressOverriddenAt: Date | null;
    fulfillmentAddressOverriddenBy: string | null;
    cartSnapshot: unknown;
    initialCurrency: string | null;
    paypalOrderId: string | null;
    djangoOrderIntentUuid: string | null;
    djangoOrderIntentOrderId: string | null;
    djangoPaymentSaveCustomId: string | null;
    merchizeFulfillmentResponsePayload: unknown;
    merchizeFulfillmentProcessingId: string | null;
    merchizeProviderOrderId: string | null;
    merchizeProviderOrderCode: string | null;
    processingCompletedAt: Date | null;
    processingTriggeredAt: Date | null;
    processingTriggerDetail: string | null;
    processingTriggerSource: string | null;
    checkoutSurfaceHost: string | null;
    checkoutSurfaceOrigin: string | null;
    checkoutSurfaceLabel: string | null;
    postProcessingLockExpiresAt: Date | null;
    status: string;
    lastErrorMessage: string | null;
    lastErrorCode: string | null;
    lastEventType: string | null;
    webhookEvents: PaidOrderRecoveryWebhookEvent[];
    merchizeFulfillmentOps: MerchizeFulfillmentOpsAdminSummary | null;
  },
): PaidOrderRecoveryDetail {
  const originalAddress = normalizeAddress(row.shippingSnapshot);
  const overrideAddress = normalizeAddress(row.fulfillmentAddressOverride);
  const activeAddress = overrideAddress ?? originalAddress;
  const merchizeProviderOrderId = row.merchizeProviderOrderId;
  const merchizeExternalOrderNumber =
    row.merchizeProviderOrderCode ??
    getMerchizeOrderCodeFromFulfillmentResponse(row.merchizeFulfillmentResponsePayload);
  const acceptedDjangoHandoff = isAcceptedDjangoFulfillmentProcessResponse(
    row.merchizeFulfillmentResponsePayload,
  );
  const acceptedMerchizeExternalOrderNumber = acceptedDjangoHandoff
    ? extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
        row.merchizeFulfillmentResponsePayload,
      )
    : null;
  const providerDetailSyncNeeded = needsProviderDetailSync(
    row.merchizeFulfillmentResponsePayload,
    row.merchizeFulfillmentOps?.syncStatus,
  );
  const captureCompletion = getPayPalCaptureCompletion(row.capturePayload);
  const canonicalPaymentChain = reconcileCanonicalPayPalPaymentChain(
    row,
    row.authorizePayload,
    row.capturePayload,
  );
  const requiresManualRelease =
    canonicalPaymentChain.ok &&
    row.status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED &&
    (row.lastErrorCode === 'MERCHIZE_PUSH_DISABLED_BY_CONFIG' ||
      row.lastErrorCode === 'MERCHIZE_MANUAL_RELEASE_REQUIRED' ||
      row.merchizeFulfillmentOps?.productionGateStatus ===
        MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_DISABLED ||
      row.merchizeFulfillmentOps?.productionGateStatus ===
        MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.MANUAL_RELEASE_REQUIRED);
  const fulfillmentRetryEligibility = getMerchizeFulfillmentRetryEligibility({
    captureComplete: captureCompletion.ok && canonicalPaymentChain.ok,
    hasAcceptedDjangoFulfillmentHandoff: acceptedDjangoHandoff,
    hasDjangoPaymentSaveCustomId: Boolean(row.djangoPaymentSaveCustomId),
    hasMerchizeExternalOrderNumber: Boolean(acceptedMerchizeExternalOrderNumber),
    hasPersistedReceipt: Boolean(row.receiptLink && row.receiptFile),
  });
  const captureAmount = asNumber(captureCompletion.amount?.value);
  const inferredProcessingSource = getPayPalLedgerInferredProcessingSourceDisplay({
    checkoutSurfaceLabel: row.checkoutSurfaceLabel,
    hasCapturePayload: Boolean(row.capturePayload),
    ledgerStatus: row.status,
  });

  return {
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    createdAt: formatLongDate(row.createdAt),
    updatedAt: formatLongDate(row.updatedAt),
    receiptLink: row.receiptLink,
    originalAddress,
    activeAddress,
    hasAddressOverride: Boolean(overrideAddress),
    addressCorrectionProviderApplied: Boolean(
      overrideAddress &&
      row.merchizeFulfillmentOps?.providerAddressUpdatedAt &&
      row.merchizeFulfillmentOps.addressReviewStatus !== 'provider_update_failed',
    ),
    addressOverrideReason: row.fulfillmentAddressOverrideReason,
    addressOverriddenAt: row.fulfillmentAddressOverriddenAt
      ? formatLongDate(row.fulfillmentAddressOverriddenAt)
      : null,
    addressOverriddenBy: row.fulfillmentAddressOverriddenBy,
    items: getRecoveryOrderItems(row),
    references: [
      { label: 'Ledger order token', value: row.orderToken },
      { label: 'Authenticated user ID', value: row.userId },
      { label: 'PayPal order ID', value: row.paypalOrderId },
      { label: 'PayPal capture proof', value: captureCompletion.reason },
      {
        label: 'Canonical payment proof',
        value: canonicalPaymentChain.ok
          ? canonicalPaymentChain.capture.reason
          : canonicalPaymentChain.reconciliation.reason,
      },
      {
        label: 'Processing source',
        value: row.processingTriggerSource ?? inferredProcessingSource?.label ?? null,
      },
      { label: 'Processing source detail', value: row.processingTriggerDetail },
      { label: 'Checkout surface host', value: row.checkoutSurfaceHost },
      { label: 'Checkout surface origin', value: row.checkoutSurfaceOrigin },
      { label: 'Django order intent UUID', value: row.djangoOrderIntentUuid },
      { label: 'Django order intent order ID', value: row.djangoOrderIntentOrderId },
      { label: 'Django payment save custom ID', value: row.djangoPaymentSaveCustomId },
      { label: 'Merchize processing ID', value: row.merchizeFulfillmentProcessingId },
      {
        label: 'Merchize platform order ID',
        value: row.merchizeFulfillmentOps?.merchizeOrderId ?? merchizeProviderOrderId,
      },
      { label: 'Merchize external order number', value: merchizeExternalOrderNumber },
      {
        label: 'Merchize Ops sync status',
        value: row.merchizeFulfillmentOps?.syncStatus ?? null,
      },
      {
        label: 'Merchize push gate status',
        value: row.merchizeFulfillmentOps?.productionGateStatus ?? null,
      },
      {
        label: 'Merchize progress status',
        value: row.merchizeFulfillmentOps?.progressStatus ?? null,
      },
      {
        label: 'Merchize delivery status',
        value: row.merchizeFulfillmentOps?.deliveryStatus ?? null,
      },
      {
        label: 'Merchize cost status',
        value: row.merchizeFulfillmentOps?.costReviewStatus ?? null,
      },
      {
        label: 'Merchize address readiness',
        value: row.merchizeFulfillmentOps?.addressReviewStatus ?? null,
      },
      {
        label: 'Merchize item readiness',
        value: row.merchizeFulfillmentOps?.itemReviewStatus ?? null,
      },
      {
        label: 'Merchize artwork readiness',
        value: row.merchizeFulfillmentOps?.artworkReviewStatus ?? null,
      },
      {
        label: 'Merchize provider attention',
        value: row.merchizeFulfillmentOps?.attentionReviewStatus ?? null,
      },
      {
        label: 'Merchize push progress',
        value: row.merchizeFulfillmentOps?.providerPushProgress ?? null,
      },
      { label: 'Latest PayPal webhook event', value: row.webhookEvents[0]?.eventType ?? null },
      {
        label: 'Latest webhook delivery status',
        value: row.webhookEvents[0]?.processingStatus ?? null,
      },
      { label: 'Scanner eligibility', value: getScannerState(row).reason },
    ],
    activity: buildActivity(row),
    paymentEvidence: {
      captured: captureCompletion.ok,
      status: captureCompletion.status,
      captureId: captureCompletion.captureId,
      paypalOrderId: row.paypalOrderId,
      amount:
        captureAmount === null
          ? null
          : formatCurrency(
              captureAmount,
              captureCompletion.amount?.currency ?? row.initialCurrency,
            ),
      djangoPaymentSaved: Boolean(row.djangoPaymentSaveCustomId),
      proof: captureCompletion.reason,
    },
    webhookEvents: row.webhookEvents,
    scannerState: getScannerState(row),
    retryMode:
      row.processingCompletedAt || !canonicalPaymentChain.ok
        ? 'none'
        : fulfillmentRetryEligibility.mode,
    merchizeFulfillmentOps: row.merchizeFulfillmentOps,
    needsProviderDetailSync: providerDetailSyncNeeded,
    requiresManualRelease,
    rawDebug: {
      orderToken: row.orderToken,
      userId: row.userId,
      status: row.status,
      lastEventType: row.lastEventType,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      paypalOrderId: row.paypalOrderId,
      djangoOrderIntentUuid: row.djangoOrderIntentUuid,
      djangoOrderIntentOrderId: row.djangoOrderIntentOrderId,
      djangoPaymentSaveCustomId: row.djangoPaymentSaveCustomId,
      merchizeFulfillmentProcessingId: row.merchizeFulfillmentProcessingId,
      merchizeProviderOrderId,
      merchizeExternalOrderNumber,
      merchizeFulfillmentOps: row.merchizeFulfillmentOps,
      needsProviderDetailSync: providerDetailSyncNeeded,
      requiresManualRelease,
      retryMode:
        row.processingCompletedAt || !canonicalPaymentChain.ok
          ? 'none'
          : fulfillmentRetryEligibility.mode,
      fulfillmentRetryEligibility,
      captureCompletion,
      canonicalPaymentChain,
      scannerState: getScannerState(row),
      webhookEvents: row.webhookEvents,
      processingTriggerSource: row.processingTriggerSource,
      processingTriggerDetail: row.processingTriggerDetail,
      processingTriggeredAt: row.processingTriggeredAt,
      checkoutSurfaceHost: row.checkoutSurfaceHost,
      checkoutSurfaceOrigin: row.checkoutSurfaceOrigin,
      checkoutSurfaceLabel: row.checkoutSurfaceLabel,
    },
  };
}

export async function listAdminPaidOrderRecoveryRows({
  filters: rawFilters,
  page,
  pageSize,
}: ListAdminPaidOrderRecoveryRowsArgs = {}): Promise<PaidOrderRecoveryListResult> {
  const filters = normalizePaidOrderRecoveryFilters(rawFilters);
  const normalizedPageSize = getPaidOrderRecoveryPageSize(pageSize);
  const requestedPage = getPaidOrderRecoveryPage(page);
  const where = buildPaidOrderRecoveryWhere(filters);
  const totalRows = await paypalTxLedger.paidOrderRecoveryProjection.count({ where });
  const initialPagination = buildPaidOrderRecoveryPagination({
    currentPage: requestedPage,
    pageSize: normalizedPageSize,
    totalRows,
  });
  const start = (initialPagination.currentPage - 1) * normalizedPageSize;
  const rows = await paypalTxLedger.paidOrderRecoveryProjection.findMany({
    where,
    orderBy: [{ paypalIntentUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
    skip: start,
    take: normalizedPageSize,
    select: {
      orderToken: true,
      adminRecoveryStatus: true,
      customerEmail: true,
      customerName: true,
      paidAmountLabel: true,
      recoveryStage: true,
      recoveryReason: true,
      processingSourceLabel: true,
      processingSourceTone: true,
      paypalIntentUpdatedAt: true,
      updatedAt: true,
      needsProviderDetailSync: true,
    },
  });
  const pagination = buildPaidOrderRecoveryPagination({
    currentPage: initialPagination.currentPage,
    pageSize: normalizedPageSize,
    totalRows,
  });

  return {
    rows: rows.map(mapProjectionRowToPaidOrderRecoveryRow),
    filters,
    pagination,
  };
}

export async function getAdminPaidOrderRecoveryDetail(orderToken: string) {
  const decodedOrderToken = decodeURIComponent(orderToken);
  const row = await paypalTxLedger.paypalIntent.findFirst({
    where: {
      OR: [{ orderToken: decodedOrderToken }, { orderToken: { startsWith: decodedOrderToken } }],
    },
  });

  if (!row) return null;

  const notifications = await paypalTxLedger.adminNotificationOutbox.findMany({
    where: { orderToken: row.orderToken },
    orderBy: { createdAt: 'desc' },
  });
  const customerNotifications = await listCustomerNotificationsForOrder(row.orderToken);
  const webhookEvents = await paypalTxLedger.paypalWebhookEvent.findMany({
    where: {
      OR: [
        { orderToken: row.orderToken },
        ...(row.paypalOrderId ? [{ paypalOrderId: row.paypalOrderId }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const mappedWebhookEvents = webhookEvents.map(mapWebhookEvent);
  const merchizeOpsSummary =
    (await getMerchizeFulfillmentOpsSummaries([row.orderToken])).get(row.orderToken) ?? null;

  return {
    row: mapLedgerRowToPaidOrderRecoveryRow({
      ...row,
      merchizeFulfillmentOpsSyncStatus: merchizeOpsSummary?.syncStatus,
      merchizeFulfillmentOpsLastSyncErrorCode: merchizeOpsSummary?.lastSyncErrorCode,
      merchizeFulfillmentOpsPrimaryBlocker: merchizeOpsSummary?.readinessBlockers[0] ?? null,
    }),
    detail: buildDetail({
      ...row,
      webhookEvents: mappedWebhookEvents,
      merchizeFulfillmentOps: merchizeOpsSummary,
    }),
    raw: row,
    timeline: buildTimeline({
      ...row,
      merchizeFulfillmentOpsSyncStatus: merchizeOpsSummary?.syncStatus,
      merchizeFulfillmentOpsLastDetailSyncAt: merchizeOpsSummary?.lastDetailSyncAt,
      merchizeFulfillmentOpsProductionGateStatus: merchizeOpsSummary?.productionGateStatus,
      merchizeFulfillmentOpsReleasedToProductionAt: merchizeOpsSummary?.releasedToProductionAt,
    }),
    notifications,
    customerNotifications,
  };
}
