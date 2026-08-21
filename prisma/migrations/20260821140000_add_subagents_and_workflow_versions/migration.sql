-- Add specialist subagents and versioned workflow snapshots.

CREATE TABLE IF NOT EXISTS "painel_subagents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "llm_provider" TEXT DEFAULT 'gemini',
    "model" TEXT,
    "allowed_tool_names" JSONB DEFAULT '[]',
    "allowed_knowledge_base_ids" JSONB DEFAULT '[]',
    "temperature" DOUBLE PRECISION DEFAULT 0.7,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "painel_subagents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "painel_subagents_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "painel_subagents_client_id_idx"
  ON "painel_subagents"("client_id");
CREATE INDEX IF NOT EXISTS "painel_subagents_is_active_idx"
  ON "painel_subagents"("is_active");

CREATE TABLE IF NOT EXISTS "workflow_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "snapshot" JSONB NOT NULL,
    "description" TEXT,
    "base_version" INTEGER,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_versions_client_id_version_key"
      UNIQUE ("client_id", "version"),
    CONSTRAINT "workflow_versions_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_versions_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_versions_company_id_idx"
  ON "workflow_versions"("company_id");
CREATE INDEX IF NOT EXISTS "workflow_versions_client_id_idx"
  ON "workflow_versions"("client_id");
CREATE INDEX IF NOT EXISTS "workflow_versions_status_idx"
  ON "workflow_versions"("status");

-- Defense-in-depth tenant isolation for direct Supabase access.
ALTER TABLE "painel_subagents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "painel_subagents_tenant_isolation" ON "painel_subagents"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM "painel_clients" pc
      WHERE pc.id = "painel_subagents".client_id
        AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "painel_clients" pc
      WHERE pc.id = "painel_subagents".client_id
        AND pc.company_id = (SELECT company_id FROM users WHERE id = auth.uid())
    )
  );

CREATE POLICY "workflow_versions_tenant_isolation" ON "workflow_versions"
  FOR ALL
  USING ("company_id" = (SELECT company_id FROM users WHERE id = auth.uid()))
  WITH CHECK ("company_id" = (SELECT company_id FROM users WHERE id = auth.uid()));

ALTER TABLE "painel_subagents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_versions" FORCE ROW LEVEL SECURITY;
