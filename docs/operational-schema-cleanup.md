# Revisão das estruturas após a retirada do BI

## Alterações

- `painel_apis.headers` contém somente cabeçalhos HTTP. Descrição de campos, schemas e encadeamento ficam em `config`; a migração também desfaz o envelope antigo `headers.headers`. `function_name` é único por cliente, gerado na inserção e preservado ao renomear/reordenar. Referências explícitas de `next_tool` são convertidas em IDs; ambiguidade interrompe a migração.
- O gerador de metadata cumulativo foi retirado. A limpeza atua somente no envelope reconhecido do gerador e preserva configurações do mapeador, provedores e `persona_blocks`.
- Removidos módulo HTTP `/chat/conversations`, controles de atribuição/modo/prioridade/etapa, cota por cliente, identificadores de mensagem sem consumidor, ponte default de webhook e locks de outbox sem uso. O chat de teste, ingestão, mensagens e dead-letter continuam ativos.
- Estado é uma relação opcional 1:1. A persistência usa merge JSONB no PostgreSQL; um trigger mantém versão e horário também para escritores externos ao ORM. Patches concorrentes de chaves diferentes não se apagam. Não há snapshots novos por turno.
- Os canais de voz gravam `current_agent_id` ao abrir/trocar agente. Heartbeat independe de webhook. A recuperação periódica usa o contrato de liveness das novas sessões; a migração exige drenagem e reconcilia estados antigos com o último heartbeat, sem estimar consumo.
- Expurgo e retenção compartilham a anonimização de consumo. Mídia é removida antes das referências. Telemetria usa `ON DELETE SET NULL` para conversa. Exclusão de cliente/empresa com consumo é bloqueada na aplicação e por FKs; não foi introduzida exclusão silenciosa de faturamento nem uma nova tabela de histórico.
- Webhooks de mensagens usam lease, token de posse, ID estável entre tentativas e reconciliação PostgreSQL/fila. Corpos de resposta remotos não são armazenados nas novas tentativas. Chamadas mantêm sua entrega v3 cifrada e retenção existente.
- Segredos HMAC passam a `signing_secret_enc`; a chave é preservada durante a conversão. Listagem/edição não expõem a chave. Criação e rotação revelam o segredo uma vez. Provedores usam `provider_credentials`; metadata conserva configurações não secretas.
- Prisma passa a representar corretamente FKs/defaults de templates/SIP. Índices cobrem FKs importantes, catálogo e consultas de consumo. O índice redundante de conversa na telemetria foi retirado; índices parciais e views SIP foram preservados.
- RLS foi habilitada nas seis tabelas restantes, usando a política existente do papel backend. Isso não substitui o escopo de tenant da aplicação. Triggers verificam empresa/cliente/conversa nos vínculos operacionais e impedem reatribuir um cliente entre empresas.
- A escolha de agente inicial é serializada por cliente e protegida por índice parcial único. Cadastros incompletos podem permanecer como rascunho, mas não podem ativar agentes. Não se preenchem identidades por suposição.
- Contadores antes chamados `audio_input_tokens`/`audio_output_tokens` agora se chamam `input_tokens`/`output_tokens`, correspondendo ao que o provider fornece. Medições nunca implementadas passam de zero desconhecido para `NULL`. Turnos são contados nas novas sessões; câmbio usa `USD_BRL_RATE`, compartilhado com Billing, e registra a taxa aplicada.

## Decisões de preservação

As 32 tabelas operacionais e as quatro views SIP continuam necessárias. Não se elimina uma tabela porque está vazia. Custos históricos não são recalculados: `agent_runs.cost` continua Decimal e os valores históricos Float da telemetria são preservados. Alterar seu tipo exige uma migração financeira específica; esta revisão retira a conversão cambial fixa dos gravadores novos. A comparação por registro é exata; a soma SQL de Float pode variar no último bit conforme a ordem física, sem alteração de registros.

Falhas/dead-letter não são descartadas automaticamente. `WEBHOOK_HISTORY_RETENTION_DAYS`, se configurado com inteiro positivo, limpa apenas conteúdo de entregas confirmadas/canceladas após o prazo; registros pendentes, mortos e falhos continuam disponíveis para investigação. A retenção de `call_exports` segue o contrato configurado por destino. Não se presume um prazo para apagar incidentes antigos.

## Publicação coordenada

1. Inventariar por ambiente campos removidos com conteúdo, agentes iniciais duplicados, vínculos entre tenants, referências `next_tool`, identidades incompletas, sessões ativas e entregas pendentes. Produção não foi auditada nesta execução.
2. Suspender novas sessões e drenar atendimentos. Parar os escritores/consumidores durante a troca; conservar Redis e entregas existentes.
3. Fazer `pg_dump -Fc`, registrar SHA-256 e restaurar uma cópia para ensaiar. Guardar a versão anterior junto do backup. Não usar `db push` nem aplicar o diff Prisma automaticamente.
4. Com a **mesma ENCRYPTION_KEY do runtime**, executar na versão nova, antes das migrations, `node -r ts-node/register scripts/prepare-structure-secrets.ts`. O script é transacional, verifica a decifragem, preserva a assinatura e não imprime credenciais. Não executar o runtime anterior depois dessa preparação. Se a coluna já foi renomeada, a preparação já ocorreu; retomar somente as migrations restantes.
5. Aplicar `prisma migrate deploy`. As cinco migrations `20260928210000` a `20260928235000` são novas; o histórico anterior permanece intacto. Interromper e revisar se uma guarda detectar dados legados ou referência ambígua.
6. Conferir contagens/hashes de mensagens, estado e consumo, além de RLS, FKs, índices, APIs e credenciais. Publicar frontend e backend juntos, gerar Prisma Client e reiniciar os serviços.
7. Validar saúde, atendimento controlado, assinatura HMAC e recebimento v3. Em falha de migração, restaurar o backup e a aplicação anterior antes de reabrir sessões; não voltar apenas o código sobre o schema novo.

## Evidência local

Backup: `scratch/structure-before-20260928.dump`, SHA-256 `E18FD0D29F9ECF649379935C283832BF10D864E2A72E28576567F8255642A13A`. Foi restaurado e usado nos ensaios. Os hashes por registro de 246 execuções, 238 telemetrias, 1.744 mensagens e 218 estados permaneceram iguais nos campos preservados.

As regressões com PostgreSQL real cobrem concorrência de estado, JSON exato, isolamento, identidade, nomes técnicos estáveis, agente inicial concorrente, expurgo/consumo, duplicação completa do Flow e entrega HTTP local com HMAC. Os testes de entrega usam destinatário loopback e dados fictícios.

As cinco migrations foram aplicadas no banco local. A comparação Prisma/PostgreSQL ficou sem diferenças. Passaram 1.278 testes de backend, 287 de frontend e os 26 testes de integração que dependem de bancos isolados. Lint sem correção automática, verificação TypeScript e builds passaram. API, voz, frontend, PostgreSQL, Redis e Asterisk ficaram saudáveis; os workers voltaram a executar. A entrega de mensagem pendente foi recuperada após o reinício.

O mapeador externo solicitado foi executado e `.agents/skills/project_architecture/SKILL.md` foi atualizado. Produção não foi acessada. A validação HTTP/HMAC foi automatizada; uma nova chamada manual no MicroSIP não foi realizada nesta execução.

Permanecem como registros operacionais para investigação 776 falhas históricas do outbox, das quais 775 apontam conversa não encontrada. Não foram recriadas conversas nem repetidos eventos sem origem válida. Um cadastro sem identidade, agentes ou conversas foi preservado como rascunho e exige nomes reais antes da ativação.
