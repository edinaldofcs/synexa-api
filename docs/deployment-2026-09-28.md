# Publicação de 28/09/2026

Backend, voz, workers e frontend foram reconstruídos e publicados juntos. A atualização inclui variáveis livres, webhook v3, retirada do BI, integridade operacional e proteção da primeira fala do agente inicial.

## Particularidades encontradas em produção

- `vw_bi_resumo_diario` ainda dependia de `painel_interactions`. A migration `20260928140000` a remove explicitamente, sem CASCADE e sem editar migrations anteriores.
- `activation_mode` e `logo_icon` eram varchar(20) e varchar(50), divergentes do contrato Text do Prisma. A migration `20260928235900` amplia os tipos sem truncamento.
- O banco pertence a `synexa_migrator` e usa FORCE RLS. Durante as migrations de dados, a administração concedeu temporariamente a associação ao papel `synexa_app`, revogando-a ao finalizar. Não foi concedido SUPERUSER nem BYPASSRLS. Ensaios futuros devem preservar o proprietário do banco ao restaurar a cópia; restaurar somente as tabelas em um banco com outro proprietário não reproduz as permissões de produção.

## Backup e validação

Backup anterior à migração: `/opt/synexa/backups/release-20260928-refactor/final.dump`.

SHA-256: `2ff5488802ae9c4e42fa8a1ec3d13bbd8bf75701a297cbd7782f7a173fe6a8ff`.

O backup foi restaurado em banco separado. As migrations foram ensaiadas antes de suspender os serviços. Hashes por registro de consumo e mensagens foram comparados antes e depois, sem diferenças. Nenhum destino de webhook nem entrega pendente existia no inventário desta publicação.

Validações locais: 1.290 testes de backend e 287 de frontend, lint e builds. Validações públicas: frontend, saúde, consulta autenticada de clientes/conversas/webhooks e WebSocket de voz. Sessão anônima foi rejeitada e sessão autenticada confirmou inscrição; a sessão temporária de diagnóstico foi removida.

As imagens anteriores ficam identificadas por `synexa-rollback-20260928:<serviço>`. Para reverter as migrations destrutivas é necessário suspender ingresso, restaurar o backup e a versão anterior de todos os serviços; não basta trocar somente a imagem. Uma nova ligação manual no MicroSIP deve conferir o comportamento acústico ponta a ponta.
