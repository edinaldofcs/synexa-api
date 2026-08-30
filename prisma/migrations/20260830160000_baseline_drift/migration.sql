-- Reconciliacao do ciclo de migrations (baseline de drift historico):
-- varias features (interactions/BI, voz/telemetria, request_id, hnsw, uniques)
-- entraram no banco via prisma db push sem migration. Esta migration
-- reconcilia o estado das migrations com o schema atual, idempotente
-- (IF NOT EXISTS / IF EXISTS) para o banco real (que ja tem tudo) e para
-- ambientes novos (shadow).

-- DropIndex
DROP INDEX IF EXISTS "inbound_events_request_id_idx";
DROP INDEX IF EXISTS "agent_runs_request_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "knowledge_embeddings_embedding_hnsw_idx";

-- DropIndex
DROP INDEX IF EXISTS "message_events_request_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "messages_request_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "painel_interactions_agreement_id_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "painel_interactions_client_identifier_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "painel_interactions_client_name_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "painel_interactions_session_id_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "tool_calls_request_id_idx";

-- AlterTable
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "debt_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "person_id";

-- AlterTable
ALTER TABLE "painel_agents" ADD COLUMN IF NOT EXISTS "allow_interrupted" BOOLEAN DEFAULT true;
ALTER TABLE "painel_agents" ADD COLUMN IF NOT EXISTS "hybrid_audio_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "painel_agents" ADD COLUMN IF NOT EXISTS "persona_blocks" JSONB;
ALTER TABLE "painel_agents" ADD COLUMN IF NOT EXISTS "voice_name" TEXT;

-- AlterTable
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "audio_gate_enabled" BOOLEAN DEFAULT true;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "audio_gate_hangover_margin_ms" INTEGER DEFAULT 500;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "audio_gate_preroll_ms" INTEGER DEFAULT 300;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "audio_gate_threshold" INTEGER DEFAULT 500;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "context_compression_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "context_compression_target_tokens" INTEGER;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "gemini_thinking_budget" INTEGER DEFAULT 0;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "gemini_thinking_level" TEXT;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "hybrid_stt_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "voice_name" TEXT;

-- AlterTable
UPDATE "telephony_endpoints" SET "created_at" = now() WHERE "created_at" IS NULL;
UPDATE "telephony_endpoints" SET "updated_at" = COALESCE("updated_at", "created_at", now());
ALTER TABLE "telephony_endpoints" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "telephony_endpoints" ALTER COLUMN "updated_at" SET NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "voice_session_telemetry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID,
    "conversation_id" UUID NOT NULL,
    "asterisk_unique_id" TEXT,
    "caller_number" TEXT,
    "did_number" TEXT,
    "hangup_cause" TEXT,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "audio_gate_forwarded_sec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "audio_gate_suppressed_sec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "audio_gate_closes" INTEGER NOT NULL DEFAULT 0,
    "interrupted_count" INTEGER NOT NULL DEFAULT 0,
    "hybrid_stt_utterances" INTEGER NOT NULL DEFAULT 0,
    "hybrid_stt_fallback_count" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "audio_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "text_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "audio_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "text_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "thoughts_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_brl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "model" TEXT,
    "voice_name" TEXT,
    "audio_gate_enabled" BOOLEAN NOT NULL DEFAULT true,
    "hybrid_stt_enabled" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_session_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "voice_session_telemetry_conversation_id_key" ON "voice_session_telemetry"("conversation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voice_session_telemetry_company_id_idx" ON "voice_session_telemetry"("company_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voice_session_telemetry_client_id_idx" ON "voice_session_telemetry"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voice_session_telemetry_conversation_id_idx" ON "voice_session_telemetry"("conversation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voice_session_telemetry_created_at_idx" ON "voice_session_telemetry"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "painel_interactions_session_id_key" ON "painel_interactions"("session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_company_id_client_id_created_at_idx" ON "painel_interactions"("company_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_client_id_has_human_answer_is_right_par_idx" ON "painel_interactions"("client_id", "has_human_answer", "is_right_party", "is_debt_presented", "is_agreement_reached", "is_promise_to_pay");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_client_identifier_idx" ON "painel_interactions"("client_identifier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_disposition_idx" ON "painel_interactions"("disposition");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_call_id_idx" ON "painel_interactions"("call_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "painel_interactions_created_at_idx" ON "painel_interactions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "business_events" DROP CONSTRAINT IF EXISTS "business_events_company_id_fkey";
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_events" DROP CONSTRAINT IF EXISTS "business_events_client_id_fkey";
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_events" DROP CONSTRAINT IF EXISTS "business_events_conversation_id_fkey";
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_events" DROP CONSTRAINT IF EXISTS "business_events_end_user_id_fkey";
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_session_telemetry" DROP CONSTRAINT IF EXISTS "voice_session_telemetry_company_id_fkey";
ALTER TABLE "voice_session_telemetry" ADD CONSTRAINT "voice_session_telemetry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_session_telemetry" DROP CONSTRAINT IF EXISTS "voice_session_telemetry_client_id_fkey";
ALTER TABLE "voice_session_telemetry" ADD CONSTRAINT "voice_session_telemetry_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_session_telemetry" DROP CONSTRAINT IF EXISTS "voice_session_telemetry_conversation_id_fkey";
ALTER TABLE "voice_session_telemetry" ADD CONSTRAINT "voice_session_telemetry_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_client_marker_created_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_client_id_marker_code_created_at_idx') THEN
    ALTER INDEX "business_events_client_marker_created_idx" RENAME TO "business_events_client_id_marker_code_created_at_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_company_marker_created_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_company_id_marker_code_created_at_idx') THEN
    ALTER INDEX "business_events_company_marker_created_idx" RENAME TO "business_events_company_id_marker_code_created_at_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_conversation_marker_key')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'business_events_conversation_id_marker_code_key') THEN
    ALTER INDEX "business_events_conversation_marker_key" RENAME TO "business_events_conversation_id_marker_code_key";
  END IF;
END $$;

