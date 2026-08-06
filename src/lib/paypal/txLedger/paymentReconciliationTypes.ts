export type PaymentLedgerRow = {
  orderToken: string;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  customerName: string;
  customerEmail: string;
  initialCurrency: string | null;
  canonicalOrderSnapshot: unknown | null;
  canonicalOrderSnapshotVersion: string | null;
  canonicalOrderSnapshotHash: string | null;
  authorizePayload: unknown;
  capturePayload: unknown;
  status: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  processingCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PayPalPaymentReconciliationRow = {
  orderToken: string;
  supportRef: string;
  customer: string;
  status: string;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  captureId: string | null;
  amount: string;
  reason: string;
  recommendedAction: string;
  risk: 'critical' | 'warning' | 'info';
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updated: string;
  createdAt: string;
  updatedAt: string;
};

export type PayPalPaymentReconciliationResult = {
  orderToken: string;
  ok: boolean;
  action: string;
  previousStatus: string;
  status: string | null;
  message: string;
  captureId: string | null;
  authorizationStatus: string | null;
  notificationCreated: number;
};

export type PayPalPaymentReconciliationRunResult = {
  ok: boolean;
  enabled: boolean;
  dryRun: boolean;
  minAgeMinutes: number;
  batchSize: number;
  scannedAt: string;
  candidates: PayPalPaymentReconciliationRow[];
  results: PayPalPaymentReconciliationResult[];
  skipped: { orderToken: string; reason: string }[];
};

export type PayPalPaymentReconciliationDashboard = {
  rows: PayPalPaymentReconciliationRow[];
  total: number;
  critical: number;
  warning: number;
  info: number;
  generatedAt: string;
  minAgeMinutes: number;
  batchSize: number;
  enabled: boolean;
};
