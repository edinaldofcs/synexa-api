BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM webhook_endpoints WHERE secret_hash IS NOT NULL AND secret_hash NOT LIKE 'enc:%') THEN
    RAISE EXCEPTION 'Run scripts/prepare-structure-secrets.ts offline with ENCRYPTION_KEY before this migration';
  END IF;
END $$;
ALTER TABLE webhook_endpoints RENAME COLUMN secret_hash TO signing_secret_enc;
COMMIT;
