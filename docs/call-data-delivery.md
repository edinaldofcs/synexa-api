# Entrega dos dados de chamadas

Em **Cliente > Webhooks**, crie/edite um destino HTTPS e selecione **Chamada encerrada · entregar e excluir dados** (`call.completed`). Configure o prazo de 1 a 168 horas (padrão 24) após encerramento e a inclusão opcional da transcrição. Há um destino ativo por cliente.

A adesão ocorre na mesma transação que cria a conversa, antes do atendimento. Somente chamadas novas entram nesta política; o histórico anterior permanece. URL, segredo e opções são congelados por chamada. Editar, desativar ou excluir um endpoint não cancela entregas de chamadas já inscritas.

## Contrato do receptor

POST JSON com `schema_version: 1`, `event: "call.completed"`, `event_id`, `occurred_at`, `company_id`, `client_id` e `call`:

- `id`, `external_id`, `started_at`, `ended_at`, `duration_seconds`, `end_reason`, `agent_id`, `caller_number`, `dialed_number`, `customer_identifier`, `customer_name` (quando disponíveis);
- `variables`: estado final; `summary`: resumo existente ou `null` (não gera outra chamada de LLM);
- `tools`: nome, resultado, estado e horário das ferramentas registradas;
- `usage`: tokens e custo da interação, quando disponíveis;
- `transcript`: lista ordenada de `sender_type`, `content`, `created_at`, somente quando habilitada.

Arquivos de áudio não são enviados por este webhook. As gravações locais padronizadas do dialplan também são removidas na limpeza. Para arquivar áudio, use gravação/armazenamento no ambiente do cliente antes de ativar esta política. URLs de gravação de terceiros não são apagadas remotamente pelo Synexa.

Headers: `X-Synexa-Event`, `X-Synexa-Event-Id`, `X-Synexa-Timestamp` (segundos Unix), `X-Synexa-Signature: sha256=<hex>`.

A assinatura é HMAC SHA-256 com o segredo do endpoint sobre **timestamp + ponto + corpo JSON bruto**, sem reformatar o corpo. Compare em tempo constante, rejeite timestamps muito antigos e use `event_id` como chave única no receptor. O timestamp e assinatura podem mudar nas repetições; ID e corpo permanecem iguais.

**Responda HTTP 2xx somente depois de gravar os dados com durabilidade.** Uma resposta 202 também confirma o recebimento e autoriza a limpeza. Se o evento já foi gravado, responda novamente 2xx. Falhas de rede e respostas fora de 2xx geram novas tentativas (5s, 10s, 20s… até 1h entre tentativas), limitadas pelo prazo. Redirecionamentos não são seguidos. O receptor nunca deve depender de entrega exatamente uma vez.

## Retenção e recuperação

`call_exports` é a fonte durável da fila. Payload e destino são cifrados com AES-256-GCM usando `ENCRYPTION_KEY`; a chave deve ser igual na API, voz e worker. Não a remova/troque sem migrar as cópias pendentes. Os registros originais da conversa permanecem nas tabelas do aplicativo até a limpeza; isso é retenção temporária, não ausência absoluta de armazenamento.

O job repetível `call-export-sweep`, na fila `webhook-delivery`, roda no `worker-webhook` ou worker completo. Busca lotes de 50 com até 5 entregas simultâneas, usa leases renováveis e não coloca conteúdo de chamadas no Redis. Uma queda do worker pode repetir o envio, mas não altera o identificador do evento. Chamadas inscritas têm heartbeat; após 2 minutos sem atualização, uma sessão não finalizada pode ser recuperada como `connection_lost`, com os dados disponíveis até a interrupção.

Após 2xx, ou após expiração sem confirmação, são removidos conversa, mensagens, partes, estado, eventos, resultados de ferramentas e cópias de entrega associadas. Conteúdo e identificadores pessoais da interação, traces do agente e telemetria são limpos. Métricas numéricas de uso/cobrança e comprovantes técnicos permanecem. O cache persistente de saudações fica desativado nas chamadas inscritas; caches antigos não são apagados retroativamente.

Mídias vinculadas exclusivamente à chamada são removidas do storage; referências compartilhadas geram falha visível para evitar apagar dados de outra finalidade. Gravações locais são removidas apenas pelos nomes exatos `<UUID>.wav` e `synexa-<UUID>.wav`, nos diretórios configurados. O worker de produção monta o volume de gravações. Instalações fora do Compose devem dar ao worker acesso ao mesmo storage (`RECORDINGS_DIR`, padrão `/app/uploads/recordings`).

A limpeza depende de banco, worker e storage disponíveis: indisponibilidade adia a execução, não deve ser interpretada como exclusão concluída. Consulte **Entrega de chamadas** no painel (últimos 100 registros, botão Atualizar) ou `GET /webhooks/call-exports?client_id=<uuid>`: `delivered` indica confirmação, `expired` indica prazo vencido sem confirmação, `purged_at` indica conclusão da limpeza, `processing_failed` exige verificar a infraestrutura. A recuperação continua automaticamente; erros são registrados sem payload ou corpo da resposta do receptor.

Backups, logs históricos, CDR/logs do PABX e retenção dos provedores externos têm ciclos próprios e não são apagados por esta rotina. Ajuste essas políticas antes de oferecer uma garantia contratual de retenção. Não use os logs para armazenar transcrição ou variáveis.

## Publicação e validação

Aplicar a migration `20260924160000_call_exports`, publicar API/voz/frontend/worker e manter `worker-webhook` ativo. A migration torna opcional a referência da telemetria à conversa para preservar minutos e custos após a exclusão. Não há migração destrutiva do histórico existente.

Testes unitários cobrem assinatura, retry, lease, expiração, transcrição opcional e falha de limpeza. `call-exports.integration.spec.ts` usa apenas banco de teste loopback informado explicitamente em `CALL_EXPORT_TEST_DATABASE_URL`; comprova adesão, unicidade do destino, cascatas e preservação de cobrança. Não definir essa variável com um banco de uso real.
