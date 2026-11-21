import type { Db } from '../db/types.js';

type DispatchDb = Pick<Db, 'deleteResponsesForRun' | 'failRunIfInProgress'>;

// A service-binding invocation owns one claimed run. Close unexpected adapter
// failures here, even if the parent fan-out's waitUntil work is interrupted.
export async function runClaimedHostedEngine(
  db: DispatchDb,
  runId: string,
  dispatch: () => Promise<void>,
): Promise<boolean> {
  try {
    await db.deleteResponsesForRun(runId);
    await dispatch();
    return true;
  } catch {
    // The conditional update preserves a run the adapter already completed,
    // and does not delete usable prompt responses saved before the failure.
    try {
      await db.failRunIfInProgress(runId, 'Hosted engine execution failed');
    } catch {
      // A second storage failure cannot justify another paid dispatch.
      console.error('Hosted engine failure could not be marked terminal', { run_id: runId });
    }
    return false;
  }
}
