-- Idempotência garantida pelo banco (defesa em profundidade além do findFirst).
-- NULLs são permitidos em múltiplas linhas por índice único no PostgreSQL.

DROP INDEX IF EXISTS "messages_idempotency_key_idx";
DROP INDEX IF EXISTS "inbound_events_idempotency_key_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "messages_company_id_idempotency_key_key"
  ON "messages"("company_id", "idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_events_client_id_channel_type_idempotency_key_key"
  ON "inbound_events"("client_id", "channel_type", "idempotency_key");
