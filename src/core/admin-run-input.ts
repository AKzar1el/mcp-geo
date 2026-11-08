import {
  ALL_ENGINES,
  isEngineName,
  uniqueEngineNames,
  type EngineName,
} from './engines.js';

export function hasRequiredIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function selectAdminRunEngines(
  requested: unknown,
  available: readonly EngineName[],
): { engineNames: EngineName[]; error?: never } | { engineNames?: never; error: string } {
  // Omitted or empty lists preserve the existing all-configured behavior.
  if (requested === undefined || (Array.isArray(requested) && requested.length === 0)) {
    return { engineNames: [...available] };
  }
  if (!Array.isArray(requested)) {
    return { error: 'engines must be an array of engine names' };
  }
  const unknown = requested.filter((engine) => typeof engine !== 'string' || !isEngineName(engine));
  if (unknown.length > 0) {
    return { error: `Unknown engines: ${unknown.join(', ')}. Allowed: ${ALL_ENGINES.join(', ')}` };
  }
  const engineNames = uniqueEngineNames(requested as EngineName[]);
  const unconfigured = engineNames.filter((engine) => !available.includes(engine));
  if (unconfigured.length > 0) {
    return { error: `Requested engines not configured: ${unconfigured.join(', ')}. Available: ${available.join(', ') || 'none'}` };
  }
  return { engineNames };
}
