import 'server-only';

import {
  getMerchizeFulfillmentOpsPrisma,
  isMerchizeFulfillmentOpsDatabaseConfigured,
} from '@/lib/prisma/shop/merchizeFulfillmentOps/merchizeFulfillmentOpsPrisma';
import { isAcceptedDjangoFulfillmentProcessResponse } from '@/lib/paypal/txLedger/fulfillmentProcessResponse';
import { CODEX_CHRISTI_FULFILLMENT_IDENTIFIER } from './fulfillmentIdentifier';
import { extractMerchizeExternalOrderNumberFromDjangoProcessResponse } from './merchizeMapper';
import { safeLogErrorMessage } from './redaction';
import { registerAcceptedMerchizeFulfillmentProcess } from './registerAcceptedMerchizeFulfillmentProcess';
import { syncMerchizeFulfillmentOrder } from './syncMerchizeFulfillmentOrder';
import type { MerchizeFulfillmentRegistrationInput } from './merchizeTypes';
import type { CanonicalOrderSnapshotLedgerEnvelope } from '@/lib/paypal/orderSnapshot/canonicalize';

type AddressCorrectionLedgerEvidence = CanonicalOrderSnapshotLedgerEnvelope & {
  orderToken: string;
  paypalOrderId: string | null;
  djangoOrderIntentUuid: string | null;
  djangoOrderIntentOrderId: string | null;
  djangoPaymentSaveCustomId: string | null;
  merchizeFulfillmentResponsePayload: unknown;
  merchizeProviderOrderCode: string | null;
  customerEmail: string | null;
  cartSnapshot: unknown;
  correctedShippingSnapshot: unknown;
};

type EnsuredAddressCorrectionTargetResult =
  | {
      ok: true;
      merchizeOrderId: string;
      backfilled: boolean;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      pending?: boolean;
    };

type AddressCorrectionResolution =
  | {
      ok: true;
      providerUpdateRequired: false;
      providerIdentityBackfilled: false;
    }
  | {
      ok: true;
      providerUpdateRequired: true;
      providerIdentityBackfilled: boolean;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
    };

async function ensureMerchizeFulfillmentAddressCorrectionTarget(
  input: MerchizeFulfillmentRegistrationInput,
): Promise<EnsuredAddressCorrectionTargetResult> {
  if (!isMerchizeFulfillmentOpsDatabaseConfigured()) {
    return {
      ok: false,
      errorCode: 'MERCHIZE_FULFILLMENT_OPS_DB_NOT_CONFIGURED',
      errorMessage: 'Merchize Fulfillment Ops database is not configured.',
    };
  }

  const prisma = getMerchizeFulfillmentOpsPrisma();
  const existing = await prisma.merchizeFulfillmentOrder.findFirst({
    where: { orderToken: input.orderToken },
    orderBy: { updatedAt: 'desc' },
    select: {
      merchizeExternalOrderNumber: true,
      merchizeOrderId: true,
    },
  });

  if (
    existing?.merchizeOrderId &&
    existing.merchizeExternalOrderNumber !== input.merchizeExternalOrderNumber
  ) {
    return {
      ok: false,
      errorCode: 'MERCHIZE_ADDRESS_CORRECTION_TARGET_MISMATCH',
      errorMessage:
        'The stored Merchize external order number does not match the accepted Django fulfillment response.',
    };
  }

  if (existing?.merchizeOrderId) {
    return {
      ok: true,
      merchizeOrderId: existing.merchizeOrderId,
      backfilled: false,
    };
  }

  try {
    const registration = await registerAcceptedMerchizeFulfillmentProcess(input);
    if (!registration.ok) {
      return {
        ok: false,
        errorCode: 'MERCHIZE_FULFILLMENT_REGISTRATION_SKIPPED',
        errorMessage: 'Accepted fulfillment registration could not be persisted.',
      };
    }

    const sync = await syncMerchizeFulfillmentOrder(input.orderToken);
    if (!sync.ok) {
      return {
        ok: false,
        errorCode: sync.errorCode,
        errorMessage: sync.errorMessage,
        pending: sync.pending,
      };
    }

    return {
      ok: true,
      merchizeOrderId: sync.merchizeOrderId,
      backfilled: true,
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'MERCHIZE_ADDRESS_CORRECTION_TARGET_FAILED',
      errorMessage: safeLogErrorMessage(error),
    };
  }
}

export async function resolveMerchizeFulfillmentAddressCorrectionTarget(
  evidence: AddressCorrectionLedgerEvidence,
): Promise<AddressCorrectionResolution> {
  if (!isAcceptedDjangoFulfillmentProcessResponse(evidence.merchizeFulfillmentResponsePayload)) {
    return {
      ok: true,
      providerUpdateRequired: false,
      providerIdentityBackfilled: false,
    };
  }

  if (!evidence.djangoPaymentSaveCustomId) {
    return {
      ok: false,
      errorCode: 'DJANGO_PAYMENT_SAVE_CUSTOM_ID_MISSING',
      errorMessage:
        'Provider identity could not be established because the Django payment save custom ID is missing.',
    };
  }

  const merchizeExternalOrderNumber = extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
    evidence.merchizeFulfillmentResponsePayload,
    evidence.djangoOrderIntentOrderId,
  );

  if (!merchizeExternalOrderNumber) {
    return {
      ok: false,
      errorCode: 'MERCHIZE_EXTERNAL_ORDER_NUMBER_MISSING',
      errorMessage:
        'Provider identity could not be established because the accepted response has no Merchize external order number.',
    };
  }

  const target = await ensureMerchizeFulfillmentAddressCorrectionTarget({
    orderToken: evidence.orderToken,
    paypalOrderId: evidence.paypalOrderId,
    djangoOrderIntentUuid: evidence.djangoOrderIntentUuid,
    djangoOrderIntentOrderId: evidence.djangoOrderIntentOrderId,
    djangoPaymentSaveCustomId: evidence.djangoPaymentSaveCustomId,
    fulfillmentIdentifier: CODEX_CHRISTI_FULFILLMENT_IDENTIFIER,
    merchizeExternalOrderNumber,
    merchizeOrderId: null,
    merchizeOrderCode: evidence.merchizeProviderOrderCode ?? merchizeExternalOrderNumber,
    merchizeStatus: null,
    djangoProcessResponsePayload: evidence.merchizeFulfillmentResponsePayload,
    customerEmail: evidence.customerEmail,
    shippingSnapshot: evidence.correctedShippingSnapshot,
    cartSnapshot: evidence.cartSnapshot,
    canonicalOrderSnapshot: evidence.canonicalOrderSnapshot,
    canonicalOrderSnapshotVersion: evidence.canonicalOrderSnapshotVersion,
    canonicalOrderSnapshotHash: evidence.canonicalOrderSnapshotHash,
  });

  if (!target.ok) {
    return {
      ok: false,
      errorCode: target.errorCode,
      errorMessage: `Provider identity could not be established: ${target.errorMessage}`,
    };
  }

  return {
    ok: true,
    providerUpdateRequired: true,
    providerIdentityBackfilled: target.backfilled,
  };
}
