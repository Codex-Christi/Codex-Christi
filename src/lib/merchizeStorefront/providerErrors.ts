export type MerchizeProviderErrorKind =
  | 'not_found'
  | 'bad_request'
  | 'forbidden_or_suspended'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'network'
  | 'unknown';

export class MerchizeProviderError extends Error {
  status: number | null;
  statusText: string | null;
  body: string | null;
  url: string;
  kind: MerchizeProviderErrorKind;

  constructor({
    url,
    status,
    statusText,
    body,
    message,
  }: {
    url: string;
    status: number | null;
    statusText?: string | null;
    body?: string | null;
    message?: string;
  }) {
    const kind = classifyMerchizeStatus(status);
    super(message ?? formatMerchizeProviderErrorMessage(url, status, statusText, body));
    this.name = 'MerchizeProviderError';
    this.url = url;
    this.status = status;
    this.statusText = statusText ?? null;
    this.body = body ?? null;
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type StatusBearingError = {
  message?: unknown;
  name?: unknown;
  status?: unknown;
  statusText?: unknown;
  info?: unknown;
};

export function classifyMerchizeStatus(status: number | null): MerchizeProviderErrorKind {
  if (status === null) return 'network';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'forbidden_or_suspended';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'provider_unavailable';
  return 'unknown';
}

export function coerceMerchizeProviderError(error: unknown, url = '') {
  if (error instanceof MerchizeProviderError) return error;

  if (!error || typeof error !== 'object') return null;

  const candidate = error as StatusBearingError;
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : String(error);

  if (name !== 'FetcherError' && candidate.status === undefined) return null;

  const normalizedStatus =
    status === null && message.toLowerCase().includes('invalid json') ? 422 : status;

  return new MerchizeProviderError({
    url,
    status: normalizedStatus,
    statusText: typeof candidate.statusText === 'string' ? candidate.statusText : null,
    body: stringifyProviderErrorInfo(candidate.info),
    message,
  });
}

export function shouldUseStorefrontSnapshot(error: unknown) {
  const providerError = coerceMerchizeProviderError(error);
  if (!providerError) return false;

  return (
    providerError.kind === 'forbidden_or_suspended' ||
    providerError.kind === 'rate_limited' ||
    providerError.kind === 'provider_unavailable' ||
    providerError.kind === 'network'
  );
}

export function merchizeErrorStatus(error: unknown) {
  const providerError = coerceMerchizeProviderError(error);
  if (!providerError) return 500;
  if (providerError.kind === 'not_found') return 404;
  if (providerError.kind === 'bad_request') return providerError.status ?? 400;
  return providerError.status ?? 500;
}

export type FetchMerchizeJsonOptions = {
  /** Opt-in request deadline. Existing callers remain unbounded unless they supply this value. */
  timeoutMs?: number;
};

function createBoundedRequestSignal(
  existingSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
) {
  if (timeoutMs === undefined) {
    return {
      signal: existingSignal ?? undefined,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Merchize request timeout must be a positive finite number.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(existingSignal?.reason);

  if (existingSignal?.aborted) abortFromCaller();
  else existingSignal?.addEventListener('abort', abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Merchize request deadline exceeded.'));
  }, Math.floor(timeoutMs));

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      existingSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export async function fetchMerchizeJson<T>(
  url: string,
  init?: RequestInit,
  options: FetchMerchizeJsonOptions = {},
): Promise<T> {
  const boundedSignal = createBoundedRequestSignal(init?.signal, options.timeoutMs);
  const requestInit =
    options.timeoutMs === undefined ? init : { ...init, signal: boundedSignal.signal };
  let response: Response;

  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    boundedSignal.cleanup();
    throw new MerchizeProviderError({
      url,
      status: null,
      message: boundedSignal.didTimeout()
        ? `Merchize request timed out after ${Math.floor(options.timeoutMs!)}ms: ${url}`
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }

  try {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new MerchizeProviderError({
        url,
        status: response.status,
        statusText: response.statusText,
        body,
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof MerchizeProviderError) throw error;
    if (boundedSignal.signal?.aborted) {
      throw new MerchizeProviderError({
        url,
        status: null,
        message: boundedSignal.didTimeout()
          ? `Merchize request timed out after ${Math.floor(options.timeoutMs!)}ms: ${url}`
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }
    throw error;
  } finally {
    boundedSignal.cleanup();
  }
}

function formatMerchizeProviderErrorMessage(
  url: string,
  status: number | null,
  statusText?: string | null,
  body?: string | null,
) {
  if (status === null) return `Merchize request failed: ${url}`;
  const bodyPreview = body ? ` - ${body.slice(0, 200)}` : '';
  return `Merchize request failed: ${status}${statusText ? ` ${statusText}` : ''}${bodyPreview}`;
}

function stringifyProviderErrorInfo(info: unknown) {
  if (!info) return null;
  if (typeof info === 'string') return info;

  try {
    return JSON.stringify(info);
  } catch {
    return String(info);
  }
}
