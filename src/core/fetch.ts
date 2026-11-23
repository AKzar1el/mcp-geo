export const PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

export function fetchWithTimeout(
  input: FetchInput,
  init: FetchInit = {},
  timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  return fetch(input, { ...init, signal });
}

// Rate limits (429) and overload (503) are transient for chat engines; one
// failed prompt otherwise drops out of a weekly scan with no second try.
const RETRY_STATUSES = new Set([429, 503]);

export function retryDelayMs(
  headers: Headers,
  attempt: number,
  baseDelayMs = 2_000,
  maxDelayMs = 30_000,
): number {
  const ms = Number(headers.get('retry-after-ms'));
  const seconds = Number(headers.get('retry-after'));
  const hinted = ms > 0 ? ms : seconds > 0 ? seconds * 1000 : 0;
  // OpenAI hints ~100 ms on a full TPM window; never wait less than the backoff.
  return Math.min(maxDelayMs, Math.max(hinted, baseDelayMs * 2 ** attempt));
}

export async function fetchWithRetry(
  input: FetchInput,
  init: FetchInit = {},
  retries = 5,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchWithTimeout(input, init);
    if (!RETRY_STATUSES.has(resp.status) || attempt >= retries) return resp;
    await resp.body?.cancel();
    await sleep(retryDelayMs(resp.headers, attempt));
  }
}
