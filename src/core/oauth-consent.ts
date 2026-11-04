// A public OAuth callback must not mint single-user MCP tokens until the
// deployment owner has configured an explicit connection gate.
export function missingConnectSecretResponse(secret: unknown): Response | null {
  if (typeof secret === 'string' && secret.trim().length > 0) {
    return null;
  }

  return new Response(
    'OAuth authorization is disabled until the deployment owner configures CONNECT_SECRET.',
    {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

// A shared secret proves control of the deployment, but not consent to
// authorize the particular client initiating this request.
export function hasExplicitClientApproval(form: FormData | null): boolean {
  const approvals = form?.getAll('approve_client') ?? [];
  return approvals.length === 1 && approvals[0] === 'yes';
}
