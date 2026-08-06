'use server';

import argon2 from 'argon2';
import { revalidatePath } from 'next/cache';
import {
  getActiveAdminUserByCodexUserId,
  getAdminUnlockRateLimit,
  recordAdminUnlockAttempt,
  writeAdminAuditLog,
} from '@/lib/admin/admin-auth-ledger';
import {
  getAdminActionErrorMessage,
  requireAdminAction,
  requireMasterAdminAction,
  type AdminAuthContext,
} from '@/lib/admin/require-admin';
import {
  ADMIN_NOTIFICATION_SEVERITY,
  enqueueAdminRecoveryNotification,
  resendAdminRecoveryNotification,
  sendPendingAdminRecoveryNotificationsForOrder,
  suppressAdminRecoveryNotification,
} from '@/lib/paypal/txLedger/adminNotificationOutbox';
import { resendCustomerNotification } from '@/lib/paypal/txLedger/customerNotificationOutbox';
import {
  runPayPalRecoveryScanner,
  runSelectedPayPalRecoveryScanner,
  type PayPalRecoveryScannerRunResult,
} from '@/lib/paypal/txLedger/recoveryScanner';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import {
  PaidFulfillmentProcessingError,
  runPaidFulfillmentProcessing,
} from '@/lib/paypal/txLedger/runPaidFulfillmentProcessing';
import { isAcceptedDjangoFulfillmentProcessResponse } from '@/lib/paypal/txLedger/fulfillmentProcessResponse';
import { getMerchizeFulfillmentRetryEligibility } from '@/lib/paypal/txLedger/fulfillmentRetryPolicy';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { getAdminOpsLedgerPrisma } from '@/lib/prisma/adminOpsLedger/adminOpsLedgerPrisma';
import { registerAcceptedMerchizeFulfillmentProcess } from '@/lib/merchizeFulfillmentOps/registerAcceptedMerchizeFulfillmentProcess';
import { syncMerchizeFulfillmentOrder } from '@/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOrder';
import { syncMerchizeFulfillmentOperationalSnapshots } from '@/lib/merchizeFulfillmentOps/syncMerchizeFulfillmentOperationalSnapshots';
import { extractMerchizeExternalOrderNumberFromDjangoProcessResponse } from '@/lib/merchizeFulfillmentOps/merchizeMapper';
import { isMerchizeLookupPendingProviderProcessingError } from '@/lib/merchizeFulfillmentOps/lookupPending';
import { CODEX_CHRISTI_FULFILLMENT_IDENTIFIER } from '@/lib/merchizeFulfillmentOps/fulfillmentIdentifier';
import { applyMerchizeFulfillmentAddressCorrection } from '@/lib/merchizeFulfillmentOps/applyMerchizeFulfillmentAddressCorrection';
import { markMerchizeFulfillmentAddressValid } from '@/lib/merchizeFulfillmentOps/markMerchizeFulfillmentAddressValid';
import { getMerchizeBuyerAddressExpectationFromLedger } from '@/lib/merchizeFulfillmentOps/addressCorrectionVerification';
import { resolveMerchizeFulfillmentAddressCorrectionTarget } from '@/lib/merchizeFulfillmentOps/resolveMerchizeFulfillmentAddressCorrectionTarget';
import { runMerchizeProductionReadinessChecks } from '@/lib/merchizeFulfillmentOps/runMerchizeProductionReadinessChecks';
import { MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS } from '@/lib/merchizeFulfillmentOps/status';
import {
  getMerchizeFulfillmentOpsPrisma,
  isMerchizeFulfillmentOpsDatabaseConfigured,
} from '@/lib/prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOpsPrisma';
import {
  assertAlignedShopOpsDataTarget,
  assertShopOpsMutationAllowed,
  getShopOpsAuditMetadata,
  type ShopOpsDataTargetStatus,
} from '@/lib/prisma/shop/shopOpsDataTarget';
import {
  savePaymentReceiptToCloud,
  type PaymentReceiptProps,
} from '@/actions/shop/paypal/processAndUploadCompletedTx/savePaymentReceiptToCloud';
import { encryptForPostProcessingServerAction } from '@/lib/utils/shop/checkout/serverPostProcessingCrypto';
import type { CartVariant } from '@/stores/shop_stores/cartStore';

type AdminNotificationActionResult =
  | { ok: true; message: string; tone?: 'success' | 'warning' }
  | {
      ok: false;
      error: string;
      errorCode?: string;
      stage?: string;
    };

const SCANNER_AUDIT_ACTIONS = [
  'shop.paid_order_recovery.scan_candidates',
  'shop.paid_order_recovery.run_selected',
] as const;

function toScannerAuditMetadata(scan: PayPalRecoveryScannerRunResult) {
  return {
    candidateCount: scan.candidates.length,
    resultCount: scan.results.length,
    skippedCount: scan.skipped.length,
    scan,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseStoredScannerRun(value: unknown): PayPalRecoveryScannerRunResult | null {
  const metadata = isRecord(value) ? value : null;
  const scan = isRecord(metadata?.scan) ? metadata.scan : null;

  if (!scan) return null;

  const candidates = Array.isArray(scan.candidates) ? scan.candidates : null;
  const results = Array.isArray(scan.results) ? scan.results : null;
  const skipped = Array.isArray(scan.skipped) ? scan.skipped : null;

  if (
    typeof scan.ok !== 'boolean' ||
    typeof scan.enabled !== 'boolean' ||
    typeof scan.dryRun !== 'boolean' ||
    typeof scan.minAgeMinutes !== 'number' ||
    typeof scan.batchSize !== 'number' ||
    typeof scan.scannedAt !== 'string' ||
    !candidates ||
    !results ||
    !skipped
  ) {
    return null;
  }

  return {
    ok: scan.ok,
    enabled: scan.enabled,
    dryRun: scan.dryRun,
    minAgeMinutes: scan.minAgeMinutes,
    batchSize: scan.batchSize,
    scannedAt: scan.scannedAt,
    candidates: candidates
      .map((candidate) => {
        if (!isRecord(candidate)) return null;

        return {
          orderToken: typeof candidate.orderToken === 'string' ? candidate.orderToken : '',
          status: typeof candidate.status === 'string' ? candidate.status : '',
          customerEmail: typeof candidate.customerEmail === 'string' ? candidate.customerEmail : '',
          customerName: typeof candidate.customerName === 'string' ? candidate.customerName : '',
          paypalOrderId:
            typeof candidate.paypalOrderId === 'string' ? candidate.paypalOrderId : null,
          receiptLink: typeof candidate.receiptLink === 'string' ? candidate.receiptLink : null,
          createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
          updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
          reason: typeof candidate.reason === 'string' ? candidate.reason : '',
          lastErrorCode:
            typeof candidate.lastErrorCode === 'string' ? candidate.lastErrorCode : null,
          lastErrorMessage:
            typeof candidate.lastErrorMessage === 'string' ? candidate.lastErrorMessage : null,
        };
      })
      .filter((candidate): candidate is PayPalRecoveryScannerRunResult['candidates'][number] =>
        Boolean(candidate?.orderToken),
      ),
    results: results
      .map((result) => {
        if (!isRecord(result)) return null;

        return {
          orderToken: typeof result.orderToken === 'string' ? result.orderToken : '',
          previousStatus: typeof result.previousStatus === 'string' ? result.previousStatus : '',
          status: typeof result.status === 'string' ? result.status : null,
          processingCompletedAt:
            typeof result.processingCompletedAt === 'string' ? result.processingCompletedAt : null,
          ok: typeof result.ok === 'boolean' ? result.ok : false,
          error: typeof result.error === 'string' ? result.error : null,
        };
      })
      .filter((result): result is PayPalRecoveryScannerRunResult['results'][number] =>
        Boolean(result?.orderToken),
      ),
    skipped: skipped
      .map((item) => {
        if (!isRecord(item)) return null;

        return {
          orderToken: typeof item.orderToken === 'string' ? item.orderToken : '',
          reason: typeof item.reason === 'string' ? item.reason : '',
        };
      })
      .filter((item): item is PayPalRecoveryScannerRunResult['skipped'][number] =>
        Boolean(item?.orderToken),
      ),
  };
}

async function verifyMasterAdminPasswordStepUp({
  password,
  action,
  targetId,
}: {
  password: string;
  action: string;
  targetId: string;
}) {
  const admin = await requireMasterAdminAction();
  const adminUser = await getActiveAdminUserByCodexUserId(admin.userID);

  if (!adminUser) {
    throw new Error('Master admin account could not be loaded.');
  }

  const rateLimit = await getAdminUnlockRateLimit(adminUser.codexUserId);
  if (rateLimit.locked) {
    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId,
      outcome: 'blocked',
      metadata: { reason: 'step_up_rate_limited' },
    });
    throw new Error(
      `Too many failed password attempts. Try again in ${rateLimit.retryAfterSeconds ?? 900} seconds.`,
    );
  }

  if (!password.trim()) {
    throw new Error('Master admin password is required.');
  }

  const passwordMatches = await argon2.verify(adminUser.passwordHash, password).catch(() => false);

  await recordAdminUnlockAttempt({
    adminUser,
    success: passwordMatches,
    failureReason: passwordMatches ? undefined : 'invalid_step_up_password',
  });

  if (!passwordMatches) {
    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId,
      outcome: 'failure',
      metadata: { reason: 'invalid_step_up_password' },
    });
    throw new Error('Master admin password is incorrect.');
  }

  return admin;
}

async function authorizeShopOpsRecoveryMutation({
  action,
  orderToken,
  password,
  reason,
}: {
  action: string;
  orderToken: string;
  password?: string;
  reason?: string;
}) {
  const baseAdmin = await requireAdminAction('shop.recovery.run');
  const targetStatus = assertAlignedShopOpsDataTarget();

  if (!targetStatus.isLocalProductionTarget) {
    assertShopOpsMutationAllowed();
    return { admin: baseAdmin, targetStatus };
  }

  if (!targetStatus.localProductionMutationsEnabled) {
    assertShopOpsMutationAllowed();
  }

  if (!reason?.trim()) {
    throw new Error(
      'A reason is required when localhost is operating on production Shop Ops data.',
    );
  }

  const admin = await verifyMasterAdminPasswordStepUp({
    password: password ?? '',
    action,
    targetId: orderToken,
  });
  assertShopOpsMutationAllowed({ localProductionMasterConfirmed: true });

  return { admin, targetStatus };
}

function getProcessingActionFailure(error: unknown, fallback: string) {
  if (error instanceof PaidFulfillmentProcessingError) {
    return {
      error: error.message,
      errorCode: error.code,
      stage: error.stage,
    };
  }

  return {
    error: getAdminActionErrorMessage(error, fallback),
  };
}

function getPaidOrderPaymentGate(row: {
  authorizePayload: unknown;
  capturePayload: unknown;
  canonicalOrderSnapshot: unknown | null;
  canonicalOrderSnapshotVersion: string | null;
  canonicalOrderSnapshotHash: string | null;
}) {
  const captureCompletion = getPayPalCaptureCompletion(row.capturePayload);
  if (!captureCompletion.ok) {
    return {
      ok: false as const,
      errorCode: 'PAYPAL_CAPTURE_VALIDATION_FAILED',
      reason: captureCompletion.reason,
      stage: 'capture_validation',
    };
  }

  const paymentChain = reconcileCanonicalPayPalPaymentChain(
    row,
    row.authorizePayload,
    row.capturePayload,
  );
  if (!paymentChain.ok) {
    return {
      ok: false as const,
      errorCode: paymentChain.reconciliation.errorCode,
      reason: paymentChain.reconciliation.reason,
      stage: `${paymentChain.failedAt}_validation`,
    };
  }

  return { ok: true as const, paymentChain };
}

function assertPaidOrderPaymentGate(row: Parameters<typeof getPaidOrderPaymentGate>[0]) {
  const gate = getPaidOrderPaymentGate(row);
  if (!gate.ok) throw new Error(`Paid-order action is blocked: ${gate.reason}`);
  return gate;
}

async function writeMerchizeFulfillmentAdminAction(args: {
  orderToken: string;
  action: string;
  actor: string;
  reason?: string | null;
  status: string;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!isMerchizeFulfillmentOpsDatabaseConfigured()) return;

  const prisma = getMerchizeFulfillmentOpsPrisma();
  const order = await prisma.merchizeFulfillmentOrder.findFirst({
    where: { orderToken: args.orderToken },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });

  await prisma.merchizeFulfillmentAdminAction.create({
    data: {
      merchizeFulfillmentOrderId: order?.id,
      orderToken: args.orderToken,
      action: args.action,
      actor: args.actor,
      reason: args.reason,
      status: args.status,
      errorMessage: args.errorMessage,
      metadata: args.metadata ? JSON.parse(JSON.stringify(args.metadata)) : undefined,
    },
  });
}

async function regeneratePaidOrderReceiptFromLedger(row: {
  orderToken: string;
  authorizePayload: unknown;
  capturePayload: unknown;
  cartSnapshot: unknown;
  canonicalOrderSnapshot: unknown | null;
  canonicalOrderSnapshotVersion: string | null;
  canonicalOrderSnapshotHash: string | null;
  customerName: string;
  customerEmail: string;
  djangoOrderIntentOrderId: string | null;
  fulfillmentAddressOverride: unknown;
}) {
  if (!row.authorizePayload) {
    throw new Error('The PayPal authorization snapshot is missing; receipt cannot be regenerated.');
  }

  const paymentGate = assertPaidOrderPaymentGate(row);
  const canonicalOrderSnapshot = paymentGate.paymentChain.snapshot;

  const payload: PaymentReceiptProps = {
    authData: row.authorizePayload as PaymentReceiptProps['authData'],
    cart: canonicalOrderSnapshot ? undefined : (row.cartSnapshot as CartVariant[]),
    canonicalOrderSnapshot,
    customer: { name: row.customerName, email: row.customerEmail },
    ORD_string: row.djangoOrderIntentOrderId ?? row.orderToken,
    shippingAddressOverride:
      (row.fulfillmentAddressOverride as PaymentReceiptProps['shippingAddressOverride']) ?? null,
  };
  const result = await savePaymentReceiptToCloud(
    encryptForPostProcessingServerAction(JSON.stringify(payload)),
  );

  if (!result.success || !('pdfReceiptLink' in result) || !('receiptFileName' in result)) {
    throw new Error('message' in result ? result.message : 'Receipt regeneration failed.');
  }

  await paypalTxLedger.paypalIntent.update({
    where: { orderToken: row.orderToken },
    data: {
      receiptLink: result.pdfReceiptLink,
      receiptFile: result.receiptFileName,
    },
  });

  return result;
}

async function reconcileCompletedLedgerWithProviderReadiness(args: {
  orderToken: string;
  readiness: Awaited<ReturnType<typeof runMerchizeProductionReadinessChecks>>;
}) {
  if (!args.readiness.ok || args.readiness.readiness.providerPushState === 'pushed') return false;
  const readiness = args.readiness.readiness;

  const row = await paypalTxLedger.paypalIntent.findUnique({
    where: { orderToken: args.orderToken },
    select: {
      status: true,
      processingCompletedAt: true,
      paypalOrderId: true,
      customerName: true,
      customerEmail: true,
      receiptLink: true,
    },
  });
  if (!row || (row.status !== PAYPAL_LEDGER_STATUS.COMPLETED && !row.processingCompletedAt)) {
    return false;
  }

  const primaryBlocker = readiness.primaryBlocker;
  const errorCode =
    primaryBlocker?.code ??
    (readiness.providerPushState === 'failed'
      ? 'MERCHIZE_PUSH_PROVIDER_STATE_FAILED'
      : 'MERCHIZE_PUSH_NOT_VERIFIED');
  const errorMessage =
    primaryBlocker?.message ??
    (readiness.providerPushState === 'failed'
      ? 'Merchize reports that the fulfillment push failed after the earlier command acknowledgment.'
      : 'The paid ledger was marked completed without a verified Merchize push state.');

  await paypalTxLedger.$transaction(async (tx) => {
    await tx.paypalIntent.update({
      where: { orderToken: args.orderToken },
      data: {
        status: PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
        processingCompletedAt: null,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        postProcessingLockId: null,
        postProcessingLockedAt: null,
        postProcessingLockExpiresAt: null,
      },
    });
    await enqueueAdminRecoveryNotification({
      db: tx,
      orderToken: args.orderToken,
      paypalOrderId: row.paypalOrderId,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      receiptLink: row.receiptLink,
      ledgerStatus: PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
      errorCode,
      errorMessage,
      issueSummary:
        readiness.blockers.length > 0
          ? readiness.blockers.map((blocker) => blocker.message)
          : [errorMessage],
      severity: ADMIN_NOTIFICATION_SEVERITY.WARNING,
    });
  });
  await refreshPaidOrderRecoveryProjectionSafely(args.orderToken);
  await sendPendingAdminRecoveryNotificationsForOrder(args.orderToken).catch(() => undefined);
  return true;
}

export type AdminRecoveryScannerActionResult =
  | {
      ok: true;
      message: string;
      scan: PayPalRecoveryScannerRunResult;
    }
  | {
      ok: false;
      error: string;
      scan?: PayPalRecoveryScannerRunResult;
    };

export async function getLatestAdminPaidOrderRecoveryScannerRun(): Promise<PayPalRecoveryScannerRunResult | null> {
  await requireAdminAction('shop.view');

  const rows = await getAdminOpsLedgerPrisma().adminAuditLog.findMany({
    where: {
      action: {
        in: [...SCANNER_AUDIT_ACTIONS],
      },
      outcome: {
        in: ['success', 'failure'],
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 10,
    select: {
      metadata: true,
    },
  });

  for (const row of rows) {
    const scan = parseStoredScannerRun(row.metadata);
    if (scan) return scan;
  }

  return null;
}

export async function scanAdminPaidOrderRecoveryCandidatesAction(): Promise<AdminRecoveryScannerActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    const targetMetadata = getShopOpsAuditMetadata(assertAlignedShopOpsDataTarget());
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.scan_candidates',
      outcome: 'started',
      metadata: targetMetadata,
    });

    const scan = await runPayPalRecoveryScanner({ dryRun: true });
    const candidateCount = scan.candidates.length;

    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.scan_candidates',
      outcome: 'success',
      metadata: {
        ...targetMetadata,
        ...toScannerAuditMetadata(scan),
      },
    });

    return {
      ok: true,
      message: candidateCount
        ? `Found ${candidateCount} recoverable row${candidateCount === 1 ? '' : 's'}.`
        : 'No recoverable rows found.',
      scan,
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Recovery scan failed.'),
    };
  }
}

export async function runSelectedAdminPaidOrderRecoveryAction({
  orderTokens,
}: {
  orderTokens: string[];
}): Promise<AdminRecoveryScannerActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    const targetMetadata = getShopOpsAuditMetadata(assertShopOpsMutationAllowed());
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.run_selected',
      targetType: 'orderTokenBatch',
      outcome: 'started',
      metadata: {
        ...targetMetadata,
        count: orderTokens.length,
      },
    });

    if (!orderTokens.length) {
      return {
        ok: false,
        error: 'Select at least one recovery row.',
      };
    }

    const scan = await runSelectedPayPalRecoveryScanner({ orderTokens });

    revalidatePath('/admin/shop/paid-order-recovery');
    for (const orderToken of orderTokens) {
      revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    }

    const completedCount = scan.results.filter((result) => result.ok).length;

    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.run_selected',
      targetType: 'orderTokenBatch',
      outcome: scan.ok ? 'success' : 'failure',
      metadata: {
        ...targetMetadata,
        requestedCount: orderTokens.length,
        completedCount,
        ...toScannerAuditMetadata(scan),
      },
    });

    if (!scan.ok) {
      return {
        ok: false,
        error:
          completedCount > 0
            ? `${completedCount} row${completedCount === 1 ? '' : 's'} completed; review remaining results.`
            : 'Selected recovery did not complete.',
        scan,
      };
    }

    return {
      ok: true,
      message: completedCount
        ? `Completed ${completedCount} recovery row${completedCount === 1 ? '' : 's'}.`
        : 'No selected rows required recovery.',
      scan,
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Selected recovery failed.'),
    };
  }
}

export async function resendAdminRecoveryNotificationAction({
  notificationId,
  orderToken,
}: {
  notificationId: string;
  orderToken: string;
}): Promise<AdminNotificationActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.notification_resend',
      targetType: 'adminNotification',
      targetId: notificationId,
      outcome: 'started',
      metadata: { orderToken },
    });

    const result = await resendAdminRecoveryNotification(notificationId);

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? 'Notification resend failed.',
      };
    }

    return {
      ok: true,
      message: 'Notification resent successfully.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Notification resend failed.'),
    };
  }
}

export async function suppressAdminRecoveryNotificationAction({
  notificationId,
  orderToken,
}: {
  notificationId: string;
  orderToken: string;
}): Promise<AdminNotificationActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.notification_suppress',
      targetType: 'adminNotification',
      targetId: notificationId,
      outcome: 'started',
      metadata: { orderToken },
    });

    await suppressAdminRecoveryNotification(notificationId);

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);

    return {
      ok: true,
      message: 'Notification suppressed.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Notification suppress failed.'),
    };
  }
}

export async function resendCustomerNotificationAction({
  notificationId,
  orderToken,
}: {
  notificationId: string;
  orderToken: string;
}): Promise<AdminNotificationActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.customer_notification_resend',
      targetType: 'customerNotification',
      targetId: notificationId,
      outcome: 'started',
      metadata: { orderToken },
    });

    const result = await resendCustomerNotification(notificationId);

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);

    if (!result.ok) {
      await writeAdminAuditLog({
        actor: admin,
        action: 'shop.paid_order_recovery.customer_notification_resend',
        targetType: 'customerNotification',
        targetId: notificationId,
        outcome: 'failure',
        metadata: { orderToken, error: result.error ?? 'Customer notification resend failed.' },
      });

      return {
        ok: false,
        error: result.error ?? 'Customer notification resend failed.',
      };
    }

    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.customer_notification_resend',
      targetType: 'customerNotification',
      targetId: notificationId,
      outcome: 'success',
      metadata: { orderToken },
    });

    return {
      ok: true,
      message: 'Customer notification resent successfully.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Customer notification resend failed.'),
    };
  }
}

export async function retryAdminPaidOrderRecoveryAction({
  orderToken,
  password,
  reason,
}: {
  orderToken: string;
  password?: string;
  reason?: string;
}): Promise<AdminNotificationActionResult> {
  const action = 'shop.paid_order_recovery.retry_post_payment';
  let auditContext: {
    admin: AdminAuthContext;
    targetStatus: ShopOpsDataTargetStatus;
  } | null = null;

  try {
    auditContext = await authorizeShopOpsRecoveryMutation({
      action,
      orderToken,
      password,
      reason,
    });
    const { admin, targetStatus } = auditContext;
    const targetMetadata = getShopOpsAuditMetadata(targetStatus);

    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
      metadata: {
        ...targetMetadata,
        executionScope: 'full_post_payment',
        hasReason: Boolean(reason?.trim()),
      },
    });

    const reject = async (error: string, errorCode?: string, stage?: string) => {
      await writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          ...targetMetadata,
          error,
          errorCode: errorCode ?? null,
          executionScope: 'full_post_payment',
          stage: stage ?? null,
        },
      });
      return { ok: false as const, error, errorCode, stage };
    };

    const existing = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        status: true,
        authorizePayload: true,
        capturePayload: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        processingCompletedAt: true,
        postProcessingLockExpiresAt: true,
        merchizeFulfillmentResponsePayload: true,
      },
    });

    if (!existing) {
      return reject('Recovery row was not found.');
    }

    if (existing.processingCompletedAt) {
      return reject('This order is already completed.');
    }

    if (existing.postProcessingLockExpiresAt && existing.postProcessingLockExpiresAt > new Date()) {
      return reject('This order is already being processed.');
    }

    const paymentGate = getPaidOrderPaymentGate(existing);
    if (!paymentGate.ok) {
      return reject(paymentGate.reason, paymentGate.errorCode, paymentGate.stage);
    }

    await runPaidFulfillmentProcessing(orderToken, {
      executionScope: 'full_post_payment',
      localProductionMasterConfirmed: targetStatus.isLocalProductionTarget,
      triggerDetail: 'admin_retry_paid_order_recovery',
      triggerSource: 'manual_admin',
    });

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    revalidatePath('/admin/shop/paid-order-recovery');

    const updated = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        status: true,
        processingCompletedAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
      },
    });

    if (!updated) {
      return reject('Recovery row could not be reloaded after retry.');
    }

    if (updated.processingCompletedAt) {
      await writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'success',
        metadata: {
          ...targetMetadata,
          executionScope: 'full_post_payment',
          resultingStatus: updated.status,
        },
      });
      return {
        ok: true,
        message: 'Order completed after retry.',
      };
    }

    return reject(
      updated.lastErrorMessage ?? `Retry ended in ${updated.status}.`,
      updated.lastErrorCode ?? undefined,
      'post_payment_resume',
    );
  } catch (error) {
    const failure = getProcessingActionFailure(error, 'Post-payment recovery failed.');
    if (auditContext) {
      await writeAdminAuditLog({
        actor: auditContext.admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          ...getShopOpsAuditMetadata(auditContext.targetStatus),
          error: failure.error,
          errorCode: failure.errorCode ?? null,
          executionScope: 'full_post_payment',
          stage: failure.stage ?? null,
        },
      }).catch(() => undefined);
    }

    return {
      ok: false,
      ...failure,
    };
  }
}

export async function retryAdminMerchizeFulfillmentAction({
  orderToken,
  password,
  reason,
}: {
  orderToken: string;
  password?: string;
  reason?: string;
}): Promise<AdminNotificationActionResult> {
  const action = 'shop.paid_order_recovery.retry_merchize_fulfillment';
  let auditContext: {
    admin: AdminAuthContext;
    targetStatus: ShopOpsDataTargetStatus;
  } | null = null;

  try {
    auditContext = await authorizeShopOpsRecoveryMutation({
      action,
      orderToken,
      password,
      reason,
    });
    const { admin, targetStatus } = auditContext;
    const targetMetadata = getShopOpsAuditMetadata(targetStatus);

    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
      metadata: {
        ...targetMetadata,
        executionScope: 'merchize_fulfillment_only',
        hasReason: Boolean(reason?.trim()),
      },
    });

    const reject = async (error: string, errorCode?: string, stage?: string) => {
      await writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          ...targetMetadata,
          error,
          errorCode: errorCode ?? null,
          executionScope: 'merchize_fulfillment_only',
          stage: stage ?? null,
        },
      });
      return { ok: false as const, error, errorCode, stage };
    };

    const existing = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        authorizePayload: true,
        capturePayload: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        djangoPaymentSaveCustomId: true,
        merchizeFulfillmentResponsePayload: true,
        postProcessingLockExpiresAt: true,
        processingCompletedAt: true,
        receiptFile: true,
        receiptLink: true,
      },
    });

    if (!existing) return reject('Recovery row was not found.');
    if (existing.processingCompletedAt) return reject('This order is already completed.');
    if (existing.postProcessingLockExpiresAt && existing.postProcessingLockExpiresAt > new Date()) {
      return reject('This order is already being processed.');
    }

    const captureCompletion = getPayPalCaptureCompletion(existing.capturePayload);
    const paymentGate = getPaidOrderPaymentGate(existing);
    if (!paymentGate.ok) {
      return reject(paymentGate.reason, paymentGate.errorCode, paymentGate.stage);
    }
    const acceptedDjangoHandoff = isAcceptedDjangoFulfillmentProcessResponse(
      existing.merchizeFulfillmentResponsePayload,
    );
    const merchizeExternalOrderNumber = acceptedDjangoHandoff
      ? extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
          existing.merchizeFulfillmentResponsePayload,
        )
      : null;
    const eligibility = getMerchizeFulfillmentRetryEligibility({
      captureComplete: captureCompletion.ok,
      hasAcceptedDjangoFulfillmentHandoff: acceptedDjangoHandoff,
      hasDjangoPaymentSaveCustomId: Boolean(existing.djangoPaymentSaveCustomId),
      hasMerchizeExternalOrderNumber: Boolean(merchizeExternalOrderNumber),
      hasPersistedReceipt: Boolean(existing.receiptLink && existing.receiptFile),
    });

    if (!eligibility.eligible) {
      return reject(
        `${eligibility.message} Use Resume post-payment processing instead.`,
        eligibility.code,
        eligibility.missingCheckpoint,
      );
    }

    await runPaidFulfillmentProcessing(orderToken, {
      executionScope: 'merchize_fulfillment_only',
      localProductionMasterConfirmed: targetStatus.isLocalProductionTarget,
      triggerDetail: 'admin_retry_merchize_fulfillment',
      triggerSource: 'manual_admin',
    });

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    revalidatePath('/admin/shop/paid-order-recovery');

    const updated = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        lastErrorCode: true,
        lastErrorMessage: true,
        processingCompletedAt: true,
        status: true,
      },
    });

    if (!updated) return reject('Recovery row could not be reloaded after fulfillment retry.');

    if (!updated.processingCompletedAt) {
      return reject(
        updated.lastErrorMessage ?? `Fulfillment retry ended in ${updated.status}.`,
        updated.lastErrorCode ?? undefined,
        'merchize_fulfillment',
      );
    }

    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'success',
      metadata: {
        ...targetMetadata,
        executionScope: 'merchize_fulfillment_only',
        resultingStatus: updated.status,
      },
    });

    return {
      ok: true,
      message: 'Merchize fulfillment completed after retry.',
    };
  } catch (error) {
    const failure = getProcessingActionFailure(error, 'Merchize fulfillment retry failed.');
    if (auditContext) {
      await writeAdminAuditLog({
        actor: auditContext.admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          ...getShopOpsAuditMetadata(auditContext.targetStatus),
          error: failure.error,
          errorCode: failure.errorCode ?? null,
          executionScope: 'merchize_fulfillment_only',
          stage: failure.stage ?? null,
        },
      }).catch(() => undefined);
    }

    return {
      ok: false,
      ...failure,
    };
  }
}

export async function releaseMerchizeFulfillmentToProductionAction({
  orderToken,
  password,
  reason,
}: {
  orderToken: string;
  password: string;
  reason: string;
}): Promise<AdminNotificationActionResult> {
  const action = 'shop.paid_order_recovery.release_fulfillment_to_production';

  try {
    const releaseReason = reason.trim();

    if (!releaseReason) {
      return {
        ok: false,
        error: 'A release reason is required.',
      };
    }

    await requireAdminAction('shop.recovery.run');
    const targetStatus = assertAlignedShopOpsDataTarget();
    if (targetStatus.isLocalProductionTarget && !targetStatus.localProductionMutationsEnabled) {
      assertShopOpsMutationAllowed();
    }

    const admin = await verifyMasterAdminPasswordStepUp({
      password,
      action,
      targetId: orderToken,
    });
    assertShopOpsMutationAllowed({
      localProductionMasterConfirmed: targetStatus.isLocalProductionTarget,
    });
    const targetMetadata = getShopOpsAuditMetadata(targetStatus);

    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
      metadata: { ...targetMetadata, hasReason: true },
    });

    const rejectAfterStepUp = async (error: string) => {
      await writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'manual_production_release',
        actor: admin.userID,
        reason: releaseReason,
        status: 'failed',
        errorMessage: error,
        metadata: targetMetadata,
      });
      await writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: { ...targetMetadata, error },
      });

      return {
        ok: false as const,
        error,
      };
    };

    await writeMerchizeFulfillmentAdminAction({
      orderToken,
      action: 'manual_production_release',
      actor: admin.userID,
      reason: releaseReason,
      status: 'started',
      metadata: targetMetadata,
    });

    const existing = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        status: true,
        authorizePayload: true,
        capturePayload: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        lastErrorCode: true,
        processingCompletedAt: true,
        postProcessingLockExpiresAt: true,
      },
    });

    if (!existing) {
      return rejectAfterStepUp('Recovery row was not found.');
    }

    if (existing.processingCompletedAt) {
      return rejectAfterStepUp('This order is already completed.');
    }

    const merchizeOpsGate = isMerchizeFulfillmentOpsDatabaseConfigured()
      ? await getMerchizeFulfillmentOpsPrisma().merchizeFulfillmentOrder.findFirst({
          where: { orderToken },
          orderBy: { updatedAt: 'desc' },
          select: { productionGateStatus: true },
        })
      : null;
    const isManualReleaseGate =
      merchizeOpsGate?.productionGateStatus ===
        MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.PUSH_DISABLED ||
      merchizeOpsGate?.productionGateStatus ===
        MERCHIZE_FULFILLMENT_PRODUCTION_GATE_STATUS.MANUAL_RELEASE_REQUIRED;

    if (
      existing.status !== PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED ||
      (!isManualReleaseGate &&
        !['MERCHIZE_PUSH_DISABLED_BY_CONFIG', 'MERCHIZE_MANUAL_RELEASE_REQUIRED'].includes(
          existing.lastErrorCode ?? '',
        ))
    ) {
      return rejectAfterStepUp('This order is not waiting on a master-admin production release.');
    }

    if (existing.postProcessingLockExpiresAt && existing.postProcessingLockExpiresAt > new Date()) {
      return rejectAfterStepUp('This order is already being processed.');
    }

    const paymentGate = getPaidOrderPaymentGate(existing);
    if (!paymentGate.ok) {
      return rejectAfterStepUp(paymentGate.reason);
    }

    await runPaidFulfillmentProcessing(orderToken, {
      overrideMerchizeFulfillmentPushDisabled: true,
      allowStaleMerchizeOrderManualRelease: true,
      executionScope: 'merchize_fulfillment_only',
      localProductionMasterConfirmed: targetStatus.isLocalProductionTarget,
      triggerDetail: 'admin_manual_production_release',
      triggerSource: 'manual_admin',
    });

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    revalidatePath('/admin/shop/paid-order-recovery');

    const updated = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        status: true,
        processingCompletedAt: true,
        lastErrorMessage: true,
      },
    });

    if (updated?.processingCompletedAt) {
      await writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'manual_production_release',
        actor: admin.userID,
        reason: releaseReason,
        status: 'succeeded',
        metadata: targetMetadata,
      });
      await writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'success',
        metadata: targetMetadata,
      });

      return {
        ok: true,
        message: 'Merchize confirmed the order moved into fulfillment.',
      };
    }

    const error = updated?.lastErrorMessage ?? `Release ended in ${updated?.status ?? 'unknown'}.`;
    await writeMerchizeFulfillmentAdminAction({
      orderToken,
      action: 'manual_production_release',
      actor: admin.userID,
      reason: releaseReason,
      status: 'failed',
      errorMessage: error,
      metadata: targetMetadata,
    });
    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'failure',
      metadata: { ...targetMetadata, error },
    });

    return {
      ok: false,
      error,
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Production release failed.'),
    };
  }
}

export async function markPaidOrderFulfillmentAddressValidAction({
  orderToken,
  password,
  reason,
}: {
  orderToken: string;
  password: string;
  reason: string;
}): Promise<AdminNotificationActionResult> {
  const action = 'shop.paid_order_recovery.mark_fulfillment_address_valid';
  const confirmationReason = reason.trim();

  if (!confirmationReason) {
    return {
      ok: false,
      error: 'A confirmation reason is required.',
    };
  }

  try {
    await requireAdminAction('shop.recovery.run');
    const targetStatus = assertAlignedShopOpsDataTarget();
    if (targetStatus.isLocalProductionTarget && !targetStatus.localProductionMutationsEnabled) {
      assertShopOpsMutationAllowed();
    }

    const admin = await verifyMasterAdminPasswordStepUp({
      password,
      action,
      targetId: orderToken,
    });
    assertShopOpsMutationAllowed({
      localProductionMasterConfirmed: targetStatus.isLocalProductionTarget,
    });
    const ledgerOrder = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        authorizePayload: true,
        capturePayload: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        fulfillmentAddressOverride: true,
        shippingSnapshot: true,
      },
    });
    if (!ledgerOrder) {
      throw new Error('Recovery row was not found.');
    }
    assertPaidOrderPaymentGate(ledgerOrder);

    const expectedAddress = getMerchizeBuyerAddressExpectationFromLedger(
      ledgerOrder.fulfillmentAddressOverride ?? ledgerOrder.shippingSnapshot,
    );
    if (!expectedAddress) {
      throw new Error(
        'The effective ledger address is incomplete and cannot be safely confirmed in Merchize.',
      );
    }

    await Promise.all([
      writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'started',
        metadata: { hasReason: true },
      }),
      writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'provider_address_mark_valid',
        actor: admin.userID,
        reason: confirmationReason,
        status: 'started',
      }),
    ]);

    const result = await markMerchizeFulfillmentAddressValid({
      orderToken,
      expectedAddress,
    });
    if (!result.ok) {
      await Promise.all([
        writeAdminAuditLog({
          actor: admin,
          action,
          targetType: 'orderToken',
          targetId: orderToken,
          outcome: 'failure',
          metadata: { errorCode: result.errorCode },
        }),
        writeMerchizeFulfillmentAdminAction({
          orderToken,
          action: 'provider_address_mark_valid',
          actor: admin.userID,
          reason: confirmationReason,
          status: 'failed',
          errorMessage: result.errorMessage,
          metadata: { errorCode: result.errorCode },
        }),
      ]);

      await refreshPaidOrderRecoveryProjectionSafely(orderToken);
      revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);

      return { ok: false, error: result.errorMessage };
    }

    const readiness = await runMerchizeProductionReadinessChecks(orderToken, {
      expectedBuyerAddress: expectedAddress,
    });
    const addressVerified =
      readiness.ok &&
      ['ready', 'buyer_confirmed'].includes(readiness.readiness.addressReviewStatus);

    if (!readiness.ok || !addressVerified) {
      const verificationMessage = readiness.ok
        ? 'Merchize acknowledged the address confirmation, but its detail response has not verified it yet. Refresh provider state before release.'
        : `Merchize acknowledged the address confirmation, but readiness verification did not complete: ${readiness.errorMessage}`;

      await Promise.all([
        writeAdminAuditLog({
          actor: admin,
          action,
          targetType: 'orderToken',
          targetId: orderToken,
          outcome: 'failure',
          metadata: {
            providerAcknowledged: result.changed,
            verificationPending: true,
          },
        }),
        writeMerchizeFulfillmentAdminAction({
          orderToken,
          action: 'provider_address_mark_valid',
          actor: admin.userID,
          reason: confirmationReason,
          status: 'partial_failure',
          errorMessage: verificationMessage,
          metadata: {
            providerAcknowledged: result.changed,
            validationStatus: result.validationStatus,
          },
        }),
      ]);

      revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
      revalidatePath('/admin/shop/paid-order-recovery');

      return {
        ok: true,
        tone: 'warning',
        message: verificationMessage,
      };
    }

    const remainingBlocker = readiness.readiness.primaryBlocker;
    await Promise.all([
      writeAdminAuditLog({
        actor: admin,
        action,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'success',
        metadata: {
          providerChanged: result.changed,
          readinessStatus: readiness.readiness.status,
          remainingBlockerCount: readiness.readiness.blockers.length,
        },
      }),
      writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'provider_address_mark_valid',
        actor: admin.userID,
        reason: confirmationReason,
        status: 'succeeded',
        metadata: {
          providerChanged: result.changed,
          validationStatus: result.validationStatus,
          readinessStatus: readiness.readiness.status,
          remainingBlockerCount: readiness.readiness.blockers.length,
        },
      }),
    ]);

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    revalidatePath('/admin/shop/paid-order-recovery');

    return {
      ok: true,
      tone: remainingBlocker ? 'warning' : 'success',
      message: remainingBlocker
        ? `The current address is confirmed in Merchize. The order remains blocked: ${remainingBlocker.message}`
        : 'The current address is confirmed in Merchize. No production push was performed.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Address confirmation failed.'),
    };
  }
}

export async function syncAdminMerchizeProviderDetailsAction({
  orderToken,
}: {
  orderToken: string;
}): Promise<AdminNotificationActionResult> {
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    assertShopOpsMutationAllowed();
    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.sync_merchize_provider_details',
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
    });

    const existing = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        orderToken: true,
        authorizePayload: true,
        capturePayload: true,
        paypalOrderId: true,
        djangoOrderIntentUuid: true,
        djangoOrderIntentOrderId: true,
        djangoPaymentSaveCustomId: true,
        customerEmail: true,
        shippingSnapshot: true,
        fulfillmentAddressOverride: true,
        cartSnapshot: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        merchizeFulfillmentResponsePayload: true,
        merchizeProviderOrderCode: true,
      },
    });

    if (!existing) {
      return {
        ok: false,
        error: 'Recovery row was not found.',
      };
    }
    assertPaidOrderPaymentGate(existing);

    if (!isAcceptedDjangoFulfillmentProcessResponse(existing.merchizeFulfillmentResponsePayload)) {
      return {
        ok: false,
        error: 'This row does not have an accepted Django fulfillment process response.',
      };
    }

    if (!existing.djangoPaymentSaveCustomId) {
      return {
        ok: false,
        error: 'Django payment save custom ID is missing.',
      };
    }

    const merchizeExternalOrderNumber = extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
      existing.merchizeFulfillmentResponsePayload,
      existing.djangoOrderIntentOrderId,
    );

    if (!merchizeExternalOrderNumber) {
      return {
        ok: false,
        error: 'Merchize external order number could not be extracted from the accepted response.',
      };
    }

    const registration = await registerAcceptedMerchizeFulfillmentProcess({
      orderToken: existing.orderToken,
      paypalOrderId: existing.paypalOrderId,
      djangoOrderIntentUuid: existing.djangoOrderIntentUuid,
      djangoOrderIntentOrderId: existing.djangoOrderIntentOrderId,
      djangoPaymentSaveCustomId: existing.djangoPaymentSaveCustomId,
      fulfillmentIdentifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
      merchizeExternalOrderNumber,
      merchizeOrderId: null,
      merchizeOrderCode: existing.merchizeProviderOrderCode ?? merchizeExternalOrderNumber,
      merchizeStatus: null,
      djangoProcessResponsePayload: existing.merchizeFulfillmentResponsePayload,
      customerEmail: existing.customerEmail,
      shippingSnapshot: existing.fulfillmentAddressOverride ?? existing.shippingSnapshot,
      cartSnapshot: existing.cartSnapshot,
      canonicalOrderSnapshot: existing.canonicalOrderSnapshot,
      canonicalOrderSnapshotVersion: existing.canonicalOrderSnapshotVersion,
      canonicalOrderSnapshotHash: existing.canonicalOrderSnapshotHash,
    });

    if (!registration.ok) {
      return {
        ok: false,
        error: 'Merchize Fulfillment Ops database is not configured.',
      };
    }

    const sync = await syncMerchizeFulfillmentOrder(existing.orderToken);

    if (!sync.ok) {
      if (isMerchizeLookupPendingProviderProcessingError(sync.errorCode)) {
        return {
          ok: true,
          tone: 'warning',
          message: sync.errorMessage,
        };
      }

      return {
        ok: false,
        error: sync.errorMessage,
      };
    }

    const [readiness, snapshots] = await Promise.all([
      runMerchizeProductionReadinessChecks(existing.orderToken, {
        expectedBuyerAddress: getMerchizeBuyerAddressExpectationFromLedger(
          existing.fulfillmentAddressOverride ?? existing.shippingSnapshot,
        ),
      }),
      syncMerchizeFulfillmentOperationalSnapshots(existing.orderToken, {
        includeInvoice: false,
      }),
    ]);
    const reopenedCompletedLedger = await reconcileCompletedLedgerWithProviderReadiness({
      orderToken: existing.orderToken,
      readiness,
    });

    await writeAdminAuditLog({
      actor: admin,
      action: 'shop.paid_order_recovery.sync_merchize_provider_details',
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: readiness.ok ? 'success' : 'failure',
      metadata: {
        readinessStatus: readiness.ok ? readiness.readiness.status : null,
        providerPushState: readiness.ok ? readiness.readiness.providerPushState : null,
        reopenedCompletedLedger,
      },
    });
    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    revalidatePath('/admin/shop/paid-order-recovery');

    if (!readiness.ok) {
      return {
        ok: true,
        tone: 'warning',
        message: `Provider details synced, but readiness verification is pending: ${readiness.errorMessage}`,
      };
    }

    if (!readiness.readiness.ready) {
      return {
        ok: true,
        tone: 'warning',
        message: `${reopenedCompletedLedger ? 'The premature completed state was reopened. ' : ''}${readiness.readiness.primaryBlocker?.message ?? 'Production readiness is blocked.'}`,
      };
    }

    return {
      ok: true,
      tone:
        readiness.readiness.providerPushState === 'pushed' && snapshots.ok ? 'success' : 'warning',
      message:
        readiness.readiness.providerPushState === 'pushed'
          ? `Merchize provider state is verified for ${sync.merchizeOrderId}.`
          : `Production readiness passed for ${sync.merchizeOrderId}, but the order is not yet verified as pushed.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Merchize provider detail sync failed.'),
    };
  }
}

export async function savePaidOrderFulfillmentAddressOverrideAction({
  orderToken,
  address,
  reason,
  password,
}: {
  orderToken: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  reason: string;
  password?: string;
}): Promise<AdminNotificationActionResult> {
  const auditAction = 'shop.paid_order_recovery.address_correction_save';
  try {
    const { admin, targetStatus } = await authorizeShopOpsRecoveryMutation({
      action: auditAction,
      orderToken,
      password,
      reason,
    });
    const targetMetadata = getShopOpsAuditMetadata(targetStatus);
    await writeAdminAuditLog({
      actor: admin,
      action: auditAction,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
      metadata: {
        ...targetMetadata,
        hasReason: Boolean(reason.trim()),
        country: address.country.trim(),
      },
    });

    if (!reason.trim()) {
      return {
        ok: false,
        error: 'A reason is required before saving an address override.',
      };
    }

    if (
      !address.line1.trim() ||
      !address.city.trim() ||
      !address.state.trim() ||
      !address.postalCode.trim() ||
      !address.country.trim()
    ) {
      return {
        ok: false,
        error: 'Address line, city, state, postal code, and country are required.',
      };
    }

    const existing = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        orderToken: true,
        paypalOrderId: true,
        authorizePayload: true,
        capturePayload: true,
        cartSnapshot: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        customerName: true,
        customerEmail: true,
        djangoOrderIntentUuid: true,
        djangoOrderIntentOrderId: true,
        djangoPaymentSaveCustomId: true,
        fulfillmentAddressOverride: true,
        merchizeFulfillmentResponsePayload: true,
        merchizeProviderOrderCode: true,
      },
    });
    if (!existing) {
      return { ok: false, error: 'Recovery row was not found.' };
    }
    assertPaidOrderPaymentGate(existing);

    const normalizedAddress = {
      shipping_address_line_1: address.line1.trim(),
      shipping_address_line_2: address.line2?.trim() ?? '',
      shipping_city: address.city.trim(),
      shipping_state: address.state.trim(),
      zip_code: address.postalCode.trim(),
      shipping_country: address.country.trim(),
    };
    await paypalTxLedger.paypalIntent.update({
      where: { orderToken },
      data: {
        fulfillmentAddressOverride: normalizedAddress,
        fulfillmentAddressOverrideReason: reason.trim(),
        fulfillmentAddressOverriddenBy: admin.userID,
        fulfillmentAddressOverriddenAt: new Date(),
      },
    });

    await writeMerchizeFulfillmentAdminAction({
      orderToken,
      action: 'provider_address_correction',
      actor: admin.userID,
      reason: reason.trim(),
      status: 'started',
      metadata: { country: normalizedAddress.shipping_country },
    });
    type ProviderCorrectionResult =
      | Awaited<ReturnType<typeof applyMerchizeFulfillmentAddressCorrection>>
      | {
          ok: true;
          providerUpdated: false;
          message: string;
        };
    let providerCorrection: ProviderCorrectionResult;
    let providerIdentityBackfilled = false;
    let providerTargetErrorCode: string | null = null;
    const target = await resolveMerchizeFulfillmentAddressCorrectionTarget({
      orderToken: existing.orderToken,
      paypalOrderId: existing.paypalOrderId,
      djangoOrderIntentUuid: existing.djangoOrderIntentUuid,
      djangoOrderIntentOrderId: existing.djangoOrderIntentOrderId,
      djangoPaymentSaveCustomId: existing.djangoPaymentSaveCustomId,
      merchizeFulfillmentResponsePayload: existing.merchizeFulfillmentResponsePayload,
      merchizeProviderOrderCode: existing.merchizeProviderOrderCode,
      customerEmail: existing.customerEmail,
      cartSnapshot: existing.cartSnapshot,
      canonicalOrderSnapshot: existing.canonicalOrderSnapshot,
      canonicalOrderSnapshotVersion: existing.canonicalOrderSnapshotVersion,
      canonicalOrderSnapshotHash: existing.canonicalOrderSnapshotHash,
      correctedShippingSnapshot: normalizedAddress,
    });

    if (!target.ok) {
      providerTargetErrorCode = target.errorCode;
      providerCorrection = {
        ok: false,
        error: target.errorMessage,
      };
    } else if (!target.providerUpdateRequired) {
      providerCorrection = {
        ok: true,
        providerUpdated: false,
        message: 'Address correction saved for the initial provider import.',
      };
    } else {
      providerIdentityBackfilled = target.providerIdentityBackfilled;
      providerCorrection = await applyMerchizeFulfillmentAddressCorrection({
        orderToken,
        customerName: existing.customerName,
        address: {
          line1: normalizedAddress.shipping_address_line_1,
          line2: normalizedAddress.shipping_address_line_2,
          city: normalizedAddress.shipping_city,
          state: normalizedAddress.shipping_state,
          postalCode: normalizedAddress.zip_code,
          country: normalizedAddress.shipping_country,
        },
      });
    }

    if (!providerCorrection.ok) {
      await writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'provider_address_correction',
        actor: admin.userID,
        reason: reason.trim(),
        status: 'failed',
        errorMessage: providerCorrection.error,
        metadata: {
          providerIdentityBackfilled,
          providerTargetErrorCode,
        },
      });
      await writeAdminAuditLog({
        actor: admin,
        action: auditAction,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          providerUpdated: false,
          localCorrectionSaved: true,
          providerIdentityBackfilled,
          providerTargetErrorCode,
        },
      });
      await refreshPaidOrderRecoveryProjectionSafely(orderToken);
      revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
      return {
        ok: false,
        error: `Correction was saved locally but Merchize was not updated: ${providerCorrection.error}`,
      };
    }

    try {
      await regeneratePaidOrderReceiptFromLedger({
        ...existing,
        fulfillmentAddressOverride: normalizedAddress,
      });
    } catch (receiptError) {
      const receiptMessage = getAdminActionErrorMessage(
        receiptError,
        'Corrected receipt regeneration failed.',
      );
      await writeMerchizeFulfillmentAdminAction({
        orderToken,
        action: 'provider_address_correction',
        actor: admin.userID,
        reason: reason.trim(),
        status: 'partial_failure',
        errorMessage: receiptMessage,
        metadata: { providerUpdated: providerCorrection.providerUpdated },
      });
      await writeAdminAuditLog({
        actor: admin,
        action: auditAction,
        targetType: 'orderToken',
        targetId: orderToken,
        outcome: 'failure',
        metadata: {
          providerUpdated: providerCorrection.providerUpdated,
          localCorrectionSaved: true,
          receiptRegenerated: false,
        },
      });
      await refreshPaidOrderRecoveryProjectionSafely(orderToken);
      revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
      return {
        ok: false,
        error: providerCorrection.providerUpdated
          ? `Merchize was updated, but the corrected receipt was not regenerated: ${receiptMessage}`
          : `The correction was saved for initial import, but the receipt was not regenerated: ${receiptMessage}`,
      };
    }
    const readiness = providerCorrection.providerUpdated
      ? await runMerchizeProductionReadinessChecks(orderToken, {
          expectedBuyerAddress: getMerchizeBuyerAddressExpectationFromLedger(normalizedAddress),
        })
      : null;

    await writeMerchizeFulfillmentAdminAction({
      orderToken,
      action: 'provider_address_correction',
      actor: admin.userID,
      reason: reason.trim(),
      status: 'succeeded',
      metadata: {
        providerUpdated: providerCorrection.providerUpdated,
        providerIdentityBackfilled,
        receiptRegenerated: true,
        readinessStatus: readiness?.ok ? readiness.readiness.status : null,
      },
    });
    await writeAdminAuditLog({
      actor: admin,
      action: auditAction,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'success',
      metadata: {
        providerUpdated: providerCorrection.providerUpdated,
        providerIdentityBackfilled,
        receiptRegenerated: true,
        readinessStatus: readiness?.ok ? readiness.readiness.status : null,
      },
    });
    await refreshPaidOrderRecoveryProjectionSafely(orderToken);

    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);

    return {
      ok: true,
      tone: readiness?.ok && !readiness.readiness.ready ? 'warning' : 'success',
      message: providerCorrection.providerUpdated
        ? readiness?.ok && !readiness.readiness.ready
          ? `Merchize and the receipt were updated. The order remains blocked: ${readiness.readiness.primaryBlocker?.message ?? 'readiness checks are incomplete.'}`
          : 'Merchize and the corrected receipt were updated. Production readiness passed.'
        : 'Address correction and receipt were saved for the initial provider import.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Address override could not be saved.'),
    };
  }
}

export async function regeneratePaidOrderReceiptAction({
  orderToken,
}: {
  orderToken: string;
}): Promise<AdminNotificationActionResult> {
  const action = 'shop.paid_order_recovery.receipt_regenerate';
  try {
    const admin = await requireAdminAction('shop.recovery.run');
    assertShopOpsMutationAllowed();
    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'started',
    });
    const row = await paypalTxLedger.paypalIntent.findUnique({
      where: { orderToken },
      select: {
        orderToken: true,
        authorizePayload: true,
        capturePayload: true,
        cartSnapshot: true,
        canonicalOrderSnapshot: true,
        canonicalOrderSnapshotVersion: true,
        canonicalOrderSnapshotHash: true,
        customerName: true,
        customerEmail: true,
        djangoOrderIntentOrderId: true,
        fulfillmentAddressOverride: true,
      },
    });
    if (!row) return { ok: false, error: 'Recovery row was not found.' };

    await regeneratePaidOrderReceiptFromLedger(row);
    await writeAdminAuditLog({
      actor: admin,
      action,
      targetType: 'orderToken',
      targetId: orderToken,
      outcome: 'success',
      metadata: { usedAddressCorrection: Boolean(row.fulfillmentAddressOverride) },
    });
    await refreshPaidOrderRecoveryProjectionSafely(orderToken);
    revalidatePath(`/admin/shop/paid-order-recovery/${encodeURIComponent(orderToken)}`);
    return {
      ok: true,
      message: row.fulfillmentAddressOverride
        ? 'Receipt regenerated with the corrected fulfillment address.'
        : 'Receipt regenerated from the original checkout record.',
    };
  } catch (error) {
    return {
      ok: false,
      error: getAdminActionErrorMessage(error, 'Receipt could not be regenerated.'),
    };
  }
}
