-- Remoção definitiva dos campos comerciais legados do modelo multitenant.
-- Liberação de tenants passa a ser feita por contrato formal, sem CNPJ e sem plano.
DROP INDEX IF EXISTS "companies_cnpj_key";

ALTER TABLE "companies" DROP COLUMN IF EXISTS "cnpj";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "plan";
