CREATE TABLE "prompt_templates" (
 "id" TEXT NOT NULL, "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
 "client_id" UUID REFERENCES "painel_clients"("id") ON DELETE CASCADE,
 "scope" TEXT NOT NULL DEFAULT 'global', "title" TEXT NOT NULL, "category" TEXT NOT NULL,
 "description" TEXT NOT NULL DEFAULT '', "content" TEXT NOT NULL, "icon" TEXT NOT NULL DEFAULT '',
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("company_id", "scope", "id"),
 CHECK (("client_id" IS NULL AND "scope" = 'global') OR ("client_id" IS NOT NULL AND "scope" = "client_id"::text))
);
CREATE INDEX "prompt_templates_client_id_idx" ON "prompt_templates"("client_id");
