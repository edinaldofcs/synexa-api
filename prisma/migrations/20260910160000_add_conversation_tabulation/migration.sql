-- Adicionar colunas de tabulação em conversations
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "track_id" UUID REFERENCES "painel_tracks"("id") ON DELETE SET NULL;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tabulation_notes" TEXT;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tabulated_at" TIMESTAMPTZ(6);
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tabulated_by" TEXT;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tabulation_history" JSONB DEFAULT '[]'::jsonb;

-- Índices para otimizar busca e relatórios de tabulação
CREATE INDEX IF NOT EXISTS "conversations_track_id_idx" ON "conversations"("track_id");
CREATE INDEX IF NOT EXISTS "conversations_tabulation_perf_idx" ON "conversations"("client_id", "status", "tabulated_at", "last_message_at");

-- Adicionar tempo de inatividade para auto-tabulação em painel_clients
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "tabulation_inactivity_minutes" INTEGER NOT NULL DEFAULT 30;
