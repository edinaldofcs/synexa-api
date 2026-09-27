-- Webhook-only HTTP evidence. Never loaded into model context or session state.
ALTER TABLE "tool_calls" ADD COLUMN "audit_enc" TEXT;
