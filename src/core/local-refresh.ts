// Local stdio refresh sequencing. The Worker uses its own service-binding
// fan-out; the CLI executes the selected engines directly and sequentially.
import {
  runEngineInProcess,
  uniqueEngineNames,
  type EngineKeys,
  type EngineName,
  type RunEnginesResult,
} from './engines.js';
import type { Brand, Db, Prompt } from '../db/types.js';

export async function runLocalRefresh(
  db: Db,
  env: EngineKeys,
  brand: Brand,
  prompts: Prompt[],
  engines: EngineName[],
  execute: typeof runEngineInProcess = runEngineInProcess,
  log: (message: string) => void = () => {},
): Promise<RunEnginesResult> {
  const run_ids: Record<string, string> = {};
  const started: EngineName[] = [];
  for (const engine of uniqueEngineNames(engines)) {
    // Atomically reuse an active reservation across concurrent MCP requests
    // or independent CLI processes sharing this SQLite database.
    const reservation = await db.reserveLiveRun(brand, engine, prompts.length);
    if (!reservation) continue;
    run_ids[engine] = reservation.run.id;
    if (!reservation.started) continue;
    started.push(engine);
    log(`refresh_brand: running ${engine} (${prompts.length} prompt${prompts.length === 1 ? '' : 's'})...`);
    try {
      await execute({ db, ...env }, brand, prompts, { engine, run_id: reservation.run.id });
    } catch (error) {
      // An unexpected adapter failure must not strand this local reservation
      // and prevent an immediate retry. Leave any completed run untouched.
      try {
        await db.failRunIfInProgress(reservation.run.id, 'Local engine execution failed');
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Local engine execution failed and its reservation could not be closed',
        );
      }
      throw error;
    }
    log(`refresh_brand: ${engine} finished`);
  }
  return { run_ids, engines: started };
}
