-- Impede criação de conversas duplicadas sob concorrência no find-or-create
-- (chaves externas NULL permanecem distintas no Postgres; o unique só vale
-- para pares client_id + external_conversation_key preenchidos).
CREATE UNIQUE INDEX "conversations_client_id_external_conversation_key_key"
  ON "conversations"("client_id", "external_conversation_key");
