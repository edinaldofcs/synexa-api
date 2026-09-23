-- Prune da poda gateway: BI (business_events) e workflow-versions (rollback)
-- Modulos removidos do codigo; dados preservados em backup previo (pg_dump).

DROP TABLE IF EXISTS "business_events";
DROP TABLE IF EXISTS "workflow_versions";