-- Cleanup: Remove deprecated legacy tables
-- These tables were replaced by the enterprise schema (Fase 5 Cutover)

DROP TABLE IF EXISTS orchestrator_chat_messages CASCADE;
DROP TABLE IF EXISTS orchestrator_sessions CASCADE;

DROP TABLE IF EXISTS painel_intentions CASCADE;
DROP TABLE IF EXISTS painel_apis CASCADE;
DROP TABLE IF EXISTS painel_agents CASCADE;

DROP TABLE IF EXISTS people_phones CASCADE;
DROP TABLE IF EXISTS phones CASCADE;
DROP TABLE IF EXISTS debts CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS people CASCADE;
DROP TABLE IF EXISTS imports CASCADE;

-- Keep painel_clients with reduced columns for backward compat
-- Only drop if no remaining references
-- painel_clients is still referenced by some enterprise tables via client_id

-- Remove old indexes no longer needed
DROP INDEX IF EXISTS idx_orchestrator_sessions_client_company;
DROP INDEX IF EXISTS idx_orchestrator_chat_messages_session;
DROP INDEX IF EXISTS idx_painel_agents_client;
DROP INDEX IF EXISTS idx_painel_apis_client;
DROP INDEX IF EXISTS idx_painel_intentions_client;
DROP INDEX IF EXISTS idx_imports_company;
DROP INDEX IF EXISTS idx_contacts_import;
DROP INDEX IF EXISTS idx_people_company;
DROP INDEX IF EXISTS idx_phones_company;
DROP INDEX IF EXISTS idx_debts_person;
