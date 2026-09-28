# Remoção do BI e webhook v3

O Synexa coleta variáveis livres; interpretação e métricas ficam no receptor do cliente. O contrato está em [call-data-delivery.md](call-data-delivery.md). A interface não oferece finalidade, funil, tabulação ou análise de sentimento.

## Implementação

- Entrada, extração e ferramentas preservam nomes e tipos, sem inferência de negócio. A validação de destinos/caminhos permanece em `extraction-validation.util.ts` e `session-variables.util.ts`.
- Configurações retiradas são rejeitadas nos contratos de escrita, inclusive nas regras de entrada e definições de extração. Propriedades homônimas dentro de valores do cliente são preservadas.
- `conversation_state` é a fonte de variáveis. `projectCollectedVariables` é usada pela prévia, entrega e consulta de Conversas. Ela exclui contexto de execução e credenciais, sem listas de nomes de negócio.
- O webhook v3 mantém turnos, auditoria HTTP protegida, HMAC, idempotência, tentativas e retenção. Dados operacionais vêm das conversas, mensagens, ferramentas e `voice_session_telemetry`.
- A voz web registra duração, término e consumo mesmo sem filtro de áudio. Billing continua usando suas fontes operacionais.

## Transição por ambiente

1. Executar `scripts/bi-removal-inventory.sql` com acesso somente de leitura. Conferir dependências SQL, configurações, sessões, endpoints e filas. Revisar também aplicações externas que consomem o webhook; o banco não prova que um receptor já suporta v3. O inventário não imprime valores pessoais nem segredos.
2. Atualizar os receptores para `schema_version: 3`, `call.variables` e `call.turns`. Não há opção de v1/v2 ou de compatibilidade com BI.
3. Suspender ingresso de novas sessões e concluir as que estão em execução. Estados históricos marcados como ativos não equivalem a sessões de voz em execução; conferir heartbeat e os processos do atendimento. Manter o worker antigo até todas as entregas antigas e limpezas terminarem. Nunca descartar ou reescrever payloads preparados.
4. Parar os escritores e tirar backup PostgreSQL em formato custom. Verificar o checksum, listar o arquivo com `pg_restore --list` e restaurá-lo em banco descartável. Guardar o backup fora do versionamento, com acesso restrito.
5. Na cópia, executar, na mesma sessão psql com `ON_ERROR_STOP=1`: `prisma/tests/bi-removal-before.sql`, `prisma/migrations/20260928150000_remove_bi_legacy/migration.sql` e `prisma/tests/bi-removal-after.sql`. Esses testes inserem dados fictícios e NÃO devem rodar no banco real. Conferem colisões, nulos, zero, false, documentos textuais, órfãos, tenant e Billing.
6. Com backup e ensaio verificados, aplicar a nova migration via `prisma migrate deploy`. Não editar migrations históricas. A migration falha diante de entregas não drenadas ou heartbeat recente; dependências desconhecidas não são removidas com CASCADE.
7. Publicar backend, voz, workers e frontend na mesma janela, regenerar Prisma e conferir saúde. Testar atendimento e recebimento em destino de teste, comparar prévia e entrega, assinatura e retenção antes de liberar ingresso.

A recuperação lê somente os mapas brutos das interações vinculadas e os caminhos conhecidos dos envelopes antigos, com correspondência de empresa e cliente. Valores atuais de `conversation_state` prevalecem inclusive quando são false, zero ou null. Métricas inferidas não são convertidas em variáveis; órfãos não geram novas conversas. A limpeza de `report_target` é restrita às definições, sem varredura recursiva dos dados.

## Reversão

Se a migration falhar, investigar a causa antes de continuar; o SQL é transacional. Se a publicação falhar depois da migration, manter ingresso suspenso, restaurar o backup verificado e a versão anterior de todos os serviços antes de reabrir atendimento. Não recriar tabelas vazias como tentativa de rollback: isso perderia o histórico. Nenhum registro de consumo deve ser recalculado.

## Evidência local — 28/09/2026

- Backup: `scratch/synexa-before-bi-removal-20260928.dump` na raiz do workspace, excluído do Git. SHA-256: `91C1C41DF408DAEA6DD1185FFBC87A267FDAF45056F90F1B53CDC21A7B97EE24`.
- Restauração e ensaios PostgreSQL concluídos. Os testes de migração passaram, incluindo preservação de valores atuais, dados aninhados com `report_target`, isolamento por tenant e registros órfãos. A trava de entregas pendentes foi exercitada e bloqueou a migration.
- Migration aplicada no banco local. Ausência confirmada das duas tabelas, das seis colunas de tabulação e dos metadados/configurações retirados. Conteúdo integral dos 246 `agent_runs`, 234 registros de telemetria e 1.731 mensagens permaneceu idêntico, comparado por hashes ordenados.
- Teste integrado com PostgreSQL e receptor HTTP loopback: sessão de voz sem filtro de áudio, fechamento, webhook v3 recebido com HMAC válida, variáveis livres e limpeza com consumo preservado. Apenas o transporte para loopback foi injetado no teste; as proteções SSRF de produção não foram alteradas.
- Produção não foi auditada nem modificada. Uma ligação SIP/PBX real com receptor externo ainda precisa ser validada na janela de publicação; o teste integrado não simula a rede da operadora.

Os testes que exigiam aliases de relatório, funil e tabulação foram substituídos por regressões de variáveis livres. Testes de serviços exclusivamente removidos foram retirados junto com esses serviços; testes de segurança, consumo, mensagens e isolamento foram preservados.
