-- Toggle de processamento da IA de texto por cliente (painel_clients).
-- TRUE (padrao): cadeia ingestion -> agent -> dispatcher via BullMQ (duravel, retry e DLQ).
-- FALSE: execucao inline no processo da API, sem infraestrutura de fila.
ALTER TABLE "painel_clients" ADD COLUMN IF NOT EXISTS "queue_enabled" BOOLEAN NOT NULL DEFAULT TRUE;
