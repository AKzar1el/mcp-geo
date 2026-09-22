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
