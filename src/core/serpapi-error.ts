// SerpAPI uses an API key in its request URL. Network errors and upstream
// bodies can echo that URL, so never persist or log those errors verbatim.
export function redactSerpApiError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) {
    const urlEncoded = new URLSearchParams({ api_key: apiKey })
      .toString().slice('api_key='.length);
    for (const value of new Set([apiKey, encodeURIComponent(apiKey), urlEncoded])) {
      if (value) message = message.split(value).join('[REDACTED]');
    }
  }
  // Also cover an unknown key in an upstream error body.
  return message.replace(/(\bapi_key=)[^\s&;"'<>]+/gi, '$1[REDACTED]');
}
