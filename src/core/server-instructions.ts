// Cross-tool workflow guidance returned during the MCP initialize handshake.
// Keep this concise: compatible hosts may add it to the model's system prompt.

export const LOCAL_SERVER_INSTRUCTIONS =
  'Use this server to measure stored AI visibility, not to infer fresh results. If the brand_id is unknown, call list_brands first. For a new local brand, call track_brand, then refresh_brand, then check_visibility. Local refresh_brand is synchronous. Use citation, competitor, history, and content-gap tools only after scan data exists. Engines without configured API keys are unavailable and must not be treated as zero visibility.';

export const HOSTED_SERVER_INSTRUCTIONS =
  'Use this server to inspect AI visibility already configured by the owner. visibility.check reads stored data; call visibility.refresh only when fresh data is requested. Hosted refresh is asynchronous: after it returns run_ids, wait about 30-60 seconds before reading results. Brand creation and prompt management are not hosted MCP tools; if a brand is missing, tell the owner to use the authenticated admin routes. Engines without configured API keys are unavailable, not zero visibility.';
