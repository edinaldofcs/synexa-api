-- CreateTable provider_credentials
CREATE TABLE IF NOT EXISTS "provider_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "label" TEXT DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'active',
    "enabled_models" JSONB DEFAULT '[]',
    "last_used_at" TIMESTAMPTZ(6),
    "last_tested_at" TIMESTAMPTZ(6),
    "health_status" TEXT DEFAULT 'unknown',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable credential_audit_logs
CREATE TABLE IF NOT EXISTS "credential_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "provider_credentials_company_id_idx" ON "provider_credentials"("company_id");
CREATE INDEX IF NOT EXISTS "provider_credentials_client_id_idx" ON "provider_credentials"("client_id");
CREATE INDEX IF NOT EXISTS "provider_credentials_provider_idx" ON "provider_credentials"("provider");
CREATE INDEX IF NOT EXISTS "provider_credentials_status_idx" ON "provider_credentials"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_client_id_provider_label_key" ON "provider_credentials"("client_id", "provider", "label");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "credential_audit_logs_company_id_idx" ON "credential_audit_logs"("company_id");
CREATE INDEX IF NOT EXISTS "credential_audit_logs_client_id_idx" ON "credential_audit_logs"("client_id");
CREATE INDEX IF NOT EXISTS "credential_audit_logs_provider_idx" ON "credential_audit_logs"("provider");
CREATE INDEX IF NOT EXISTS "credential_audit_logs_action_idx" ON "credential_audit_logs"("action");
CREATE INDEX IF NOT EXISTS "credential_audit_logs_created_at_idx" ON "credential_audit_logs"("created_at");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_company_id_fkey') THEN
    ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_credentials_client_id_fkey') THEN
    ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credential_audit_logs_company_id_fkey') THEN
    ALTER TABLE "credential_audit_logs" ADD CONSTRAINT "credential_audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credential_audit_logs_client_id_fkey') THEN
    ALTER TABLE "credential_audit_logs" ADD CONSTRAINT "credential_audit_logs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "painel_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
