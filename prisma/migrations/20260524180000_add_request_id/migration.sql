-- Add request_id for end-to-end traceability

-- AlterTable: inbound_events
ALTER TABLE "inbound_events" ADD COLUMN "request_id" TEXT;

-- AlterTable: messages
ALTER TABLE "messages" ADD COLUMN "request_id" TEXT;

-- AlterTable: agent_runs
ALTER TABLE "agent_runs" ADD COLUMN "request_id" TEXT;

-- AlterTable: tool_calls
ALTER TABLE "tool_calls" ADD COLUMN "request_id" TEXT;

-- AlterTable: message_events
ALTER TABLE "message_events" ADD COLUMN "request_id" TEXT;

-- CreateIndex for faster request_id lookups
CREATE INDEX "inbound_events_request_id_idx" ON "inbound_events"("request_id");
CREATE INDEX "messages_request_id_idx" ON "messages"("request_id");
CREATE INDEX "agent_runs_request_id_idx" ON "agent_runs"("request_id");
CREATE INDEX "tool_calls_request_id_idx" ON "tool_calls"("request_id");
CREATE INDEX "message_events_request_id_idx" ON "message_events"("request_id");
