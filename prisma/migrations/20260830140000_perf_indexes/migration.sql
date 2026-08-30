-- Performance indexes (Fase 5 do perf-action-plan: P21, P22, P43, P44, P46, P26)
CREATE INDEX IF NOT EXISTS "conversations_company_id_mode_status_assigned_to_idx"
  ON "conversations"("company_id", "mode", "status", "assigned_to");

CREATE INDEX IF NOT EXISTS "conversations_company_id_last_message_at_idx"
  ON "conversations"("company_id", "last_message_at" DESC);

CREATE INDEX IF NOT EXISTS "conversations_company_id_last_inbound_at_idx"
  ON "conversations"("company_id", "last_inbound_at" DESC);

CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_idx"
  ON "messages"("conversation_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "business_events_company_id_created_at_idx"
  ON "business_events"("company_id", "created_at");

CREATE INDEX IF NOT EXISTS "business_events_client_id_created_at_idx"
  ON "business_events"("client_id", "created_at");

CREATE INDEX IF NOT EXISTS "painel_interactions_company_id_created_at_idx"
  ON "painel_interactions"("company_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "painel_interactions_company_id_status_idx"
  ON "painel_interactions"("company_id", "status");

CREATE INDEX IF NOT EXISTS "painel_clients_company_id_idx"
  ON "painel_clients"("company_id");

-- Trigram search indexes (P26): ILIKE '%x%' em 4 colunas de painel_interactions
-- (analytics.service.ts). Nao expressavel em schema.prisma; manter em sync manual.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "painel_interactions_client_identifier_trgm_idx"
  ON "painel_interactions" USING gin ("client_identifier" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "painel_interactions_client_name_trgm_idx"
  ON "painel_interactions" USING gin ("client_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "painel_interactions_agreement_id_trgm_idx"
  ON "painel_interactions" USING gin ("agreement_id" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "painel_interactions_session_id_trgm_idx"
  ON "painel_interactions" USING gin ("session_id" gin_trgm_ops);
