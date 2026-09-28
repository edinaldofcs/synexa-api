# Variáveis livres

O cliente configura a origem do dado e o nome da variável. Não existem aliases de negócio, nomes reservados de contato nem finalidades de relatório. `cpf`, `cpc`, `acordo` e `valor_original` são dados comuns.

## Entrada e extração

Parâmetros posicionais de telefonia são `param_1`, `param_2` etc. Regras de entrada mantêm transformações, defaults e a opção `preserve_unmapped`, inclusive sem regras. Uma regra escreve somente o destino configurado, preservando maiúsculas e minúsculas.

```json
{
  "Pessoa": "cliente.nome",
  "Documento": "cliente.documento",
  "Confirmou": { "value": false },
  "Total": { "value": 0 },
  "Literal": { "value": "cliente.nome" }
}
```

Extrações condicionais e encadeamento permanecem disponíveis. `{ "value": ... }` representa valor fixo; uma string simples representa caminho exato da resposta. Não há busca por campos equivalentes. `report_target` não é aceito nas definições de extração ou regras de entrada; objetos de dados do cliente não são interpretados como configuração.

## Ferramentas e identidade

`set_session_variable` escreve só a chave solicitada. Fontes `system` das APIs consultam apenas a variável indicada; ausência de campo obrigatório impede a chamada com `SESSION_VARIABLE_REQUIRED`. Destinos e caminhos perigosos continuam bloqueados.

Nome da empresa e nome do agente IA são obrigatórios no cadastro. `{{nome_empresa}}` e `{{nome_agente}}` vêm exclusivamente desses campos. Recursos de data, hora, saudação temporal e dias úteis são preservados e aparecem no catálogo de sistema. A saudação interpola sem alterar o estado ou abreviar nomes.

## Entrega

Conversas mostra as variáveis como nomes e valores. O [webhook v3](call-data-delivery.md) entrega `call.variables` a partir do estado persistido, sem funil, resumo, tabulação ou sentimento gerado. Prévia e entrega usam a mesma projeção de dados. Contexto interno e credenciais não são exportados.

A interpretação e as métricas ficam no sistema do cliente. Consulte [a transição de banco e publicação](bi-removal.md).
