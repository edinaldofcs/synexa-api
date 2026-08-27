-- CreateTable telephony_endpoints
CREATE TABLE IF NOT EXISTS "telephony_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID,
    "provider" TEXT NOT NULL,
    "did_number" TEXT NOT NULL,
    "label" TEXT,
    "agent_step" TEXT,
    "audio_format" TEXT NOT NULL DEFAULT 'g711_ulaw',
    "interaction_mode" TEXT NOT NULL DEFAULT 'voice',
    "inbound_secret_hash" TEXT,
    "config" JSONB DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telephony_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telephony_endpoints_company_id_idx" ON "telephony_endpoints"("company_id");
CREATE INDEX IF NOT EXISTS "telephony_endpoints_client_id_idx" ON "telephony_endpoints"("client_id");
CREATE INDEX IF NOT EXISTS "telephony_endpoints_provider_idx" ON "telephony_endpoints"("provider");
CREATE UNIQUE INDEX IF NOT EXISTS "telephony_endpoints_did_number_provider_key" ON "telephony_endpoints"("did_number", "provider");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telephony_endpoints_company_id_fkey') THEN
    ALTER TABLE "telephony_endpoints" ADD CONSTRAINT "telephony_endpoints_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telephony_endpoints_client_id_fkey') THEN
    ALTER TABLE "telephony_endpoints" ADD CONSTRAINT "telephony_endpoints_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Defense-in-depth tenant isolation for direct Supabase access.
ALTER TABLE "telephony_endpoints" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telephony_endpoints_tenant_isolation" ON "telephony_endpoints"
  FOR ALL
  USING ("company_id" = (SELECT company_id FROM users WHERE id = auth.uid()))
  WITH CHECK ("company_id" = (SELECT company_id FROM users WHERE id = auth.uid()));

ALTER TABLE "telephony_endpoints" FORCE ROW LEVEL SECURITY;
