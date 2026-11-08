-- Record the latest change to mention-matching identity (name, domain,
-- aliases, exclusions). Existing rows remain NULL: historical changes
-- predating this migration cannot be reconstructed.
ALTER TABLE brands ADD COLUMN identity_changed_at INTEGER;
