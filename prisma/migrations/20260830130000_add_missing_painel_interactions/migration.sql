-- Restaura o ciclo de migrations: painel_interactions foi criada fora do prisma
-- migrate (db push manual no commit e649cdd) e o DDL nunca entrou em migration.

CREATE TABLE IF NOT EXISTS "painel_interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "agent_id" UUID,
    "session_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'webchat',
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "interaction_mode" TEXT NOT NULL DEFAULT 'both',
    "client_identifier" TEXT,
    "company_identifier" TEXT,
    "client_name" TEXT,
    "agent_name" TEXT,
    "has_human_answer" BOOLEAN NOT NULL DEFAULT false,
    "human_answered_at" TIMESTAMPTZ(6),
    "is_right_party" BOOLEAN NOT NULL DEFAULT false,
    "right_party_at" TIMESTAMPTZ(6),
    "is_debt_presented" BOOLEAN NOT NULL DEFAULT false,
    "debt_presented_at" TIMESTAMPTZ(6),
    "debt_amount" DECIMAL(10,2),
    "is_agreement_reached" BOOLEAN NOT NULL DEFAULT false,
    "agreement_at" TIMESTAMPTZ(6),
    "agreement_id" TEXT,
    "agreement_amount" DECIMAL(10,2),
    "payment_method" TEXT,
    "is_promise_to_pay" BOOLEAN NOT NULL DEFAULT false,
    "promise_to_pay_at" TIMESTAMPTZ(6),
    "promise_due_date" DATE,
    "promise_amount" DECIMAL(10,2),
    "disposition" TEXT,
    "service_step" TEXT,
    "tagcode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ongoing',
    "barge_in_count" INTEGER NOT NULL DEFAULT 0,
    "avg_barge_in_latency_ms" INTEGER,
    "avg_first_byte_latency_ms" INTEGER,
    "is_answering_machine" BOOLEAN NOT NULL DEFAULT false,
    "call_id" TEXT,
    "call_status" TEXT,
    "recording_url" TEXT,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "billable_seconds" INTEGER NOT NULL DEFAULT 0,
    "hangup_cause" TEXT,
    "llm_provider" TEXT,
    "llm_model" TEXT,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(10,6),
    "avg_latency_ms" INTEGER,
    "sentiment" TEXT,
    "summary" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "context_variables" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "painel_interactions_pkey" PRIMARY KEY ("id")
);

-- Foreign keys (idempotente: o banco de producao ja as possui; aqui entram no
-- ciclo para novos ambientes)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'painel_interactions_company_id_fkey') THEN
    ALTER TABLE "painel_interactions"
      ADD CONSTRAINT "painel_interactions_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'painel_interactions_client_id_fkey') THEN
    ALTER TABLE "painel_interactions"
      ADD CONSTRAINT "painel_interactions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'painel_interactions_agent_id_fkey') THEN
    ALTER TABLE "painel_interactions"
      ADD CONSTRAINT "painel_interactions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "painel_agents"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;
