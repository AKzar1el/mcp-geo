-- Marks any pre-existing in_progress runs as failed. Safe to run repeatedly.
-- New runs from runLive() after this patch correctly transition to
-- 'completed' (parallel batching keeps wall-clock inside Worker invocation
-- limits), so this is a one-time cleanup of state corrupted by the
-- pre-patch sequential loop.

UPDATE runs
   SET status = 'failed',
       error = 'Run killed by Worker invocation timeout; pre-patch sequential loop',
       completed_at = COALESCE(completed_at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
 WHERE status = 'in_progress';
