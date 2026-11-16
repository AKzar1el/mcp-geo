// Provider error bodies and transport failures can echo request credentials.
// Keep diagnostics useful without exposing the configured key or URL-encoded forms.
export function redactProviderError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (!apiKey) return message;

  const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
  for (const value of new Set([apiKey, encodeURIComponent(apiKey), formEncoded])) {
    if (value) message = message.split(value).join('[REDACTED]');
  }
  return message;
}
