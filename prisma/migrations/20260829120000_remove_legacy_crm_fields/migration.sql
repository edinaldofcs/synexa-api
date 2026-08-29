-- Remove campos legados de integracao com CRM/Chatwoot do painel_clients.
-- A integracao com canais externos agora vive em channel_connections / provider_credentials.
ALTER TABLE "painel_clients"
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "account_id",
  DROP COLUMN IF EXISTS "inbox_id";
