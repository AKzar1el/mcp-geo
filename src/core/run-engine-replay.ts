import type { Run } from '../db/types.js';

// A dispatched run ID identifies one immutable measurement attempt. Replaying
// a terminal ID must not erase stored evidence or trigger another paid scan.
export function validateExistingEngineRun(
  run: Run | null,
  brandId: string,
  engine: string,
  promptsTotal: number,
): string | null {
  if (!run) return null; // The per-engine worker may create the parent row.
  if (
    run.brand_id !== brandId ||
    run.engine !== engine ||
    run.mode !== 'live' ||
    run.prompts_total !== promptsTotal
  ) {
    return 'run_id belongs to a different brand, engine, mode, or prompt count';
  }
  if (run.status === 'completed' || run.status === 'failed') {
    return `run_id is already ${run.status}; start a new refresh instead of replaying a finished run`;
  }
  return null;
}
