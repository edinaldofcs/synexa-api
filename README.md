# Synexa API

Backend NestJS do painel Synexa. O runtime pode executar API, Voice Gateway ou
workers a partir da mesma imagem, controlado por `SERVICE_ROLE`.

| Modo | `ENVIRONMENT` | Auth | Storage | Banco |
|---|---|---|---|---|
| Desenvolvimento | `development` | Sessão local em cookie HttpOnly | Disco local (`./uploads/`) | PostgreSQL local (Docker) |
| Produção | `production` | Supabase Auth + sessão em cookie HttpOnly | Supabase Storage | Supabase Pooler |

## Setup Desenvolvimento

### Pré-requisitos

- Docker Desktop
- Node.js 22+

### 1. Subir dependências

```bash
cd ..
docker compose up -d db redis
cd synexa-api
```

### 2. Instalar pacotes

```bash
npm ci
```

### 3. Aplicar migrations

```bash
npm run db:migrate
```

### 4. Gerar Prisma Client

```bash
npx prisma generate
```

### 5. Seed (cria admin local)

```bash
npm run seed
```

### 6. Iniciar servidor

```bash
npm run start:dev
```

A API roda em `http://localhost:3000/api`.

Para executar os demais runtimes no host:

```bash
npm run start:voice
npm run start:worker
npm run start:worker:agent
```

O comando `start:worker` executa todos os processors. Os comandos
`start:worker:*` executam somente a fila correspondente.

### Credenciais de desenvolvimento

| Campo | Valor |
|---|---|
| Email | `admin@synexa.com.br` |
| Senha | `SynexaAdmin2026!` |

## Variáveis de Ambiente

| Variável | Obrigatório | Descrição |
|---|---|---|
| `ENVIRONMENT` | Sim | `development` ou `production` |
| `DATABASE_URL` | Sim | URL de conexão PostgreSQL |
| `JWT_SECRET` | Sim (dev) | Secret para assinar JWTs locais |
| `SUPABASE_URL` | Sim (prod) | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim (prod) | Service role key do Supabase |
| `REDIS_URL` | Sim | URL do Redis |

## Produção (Supabase)

Em produção, o backend valida o usuário no Supabase e mantém a sessão da aplicação em cookie HttpOnly armazenado no Redis. O frontend não recebe access tokens. Defina `ENVIRONMENT=production`, `AUTH_PROVIDER=supabase`, as variáveis `SUPABASE_*` e configure `AUTH_CALLBACK_URL`/`AUTH_FRONTEND_URL` para o domínio público.

O painel usa cookies com proteção CSRF. Integrações externas não devem reutilizar a sessão do navegador: use API keys ou assinatura HMAC.

## Testes

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e
```

Os testes E2E são executados serialmente para evitar concorrência entre
instâncias NestJS que compartilham o banco local.

## Busca paginada de conversas

`GET /api/conversations/search` usa a empresa da sessão, inclusive durante
impersonação. Aceita `client_id` (UUID), `filter` (active/closed/deals/cpc),
`outcome` (all/deals/cpc), `channel` (all/whatsapp/voice/webchat/api), `start`
e `end` (ISO 8601), `search` (até 200 caracteres), `page` (padrão 1) e `limit`
(padrão 50, máximo 100). O período filtra a última mensagem, ou a criação
quando ainda não há mensagem. A busca textual é literal, sem curingas SQL.

A resposta contém `{ data, total, page, limit, counts }`. `total` considera
os filtros; `counts` contém active/closed/deals/cpc de toda a empresa ou do
cliente selecionado, antes dos demais filtros. A rota legada de listagem
continua disponível com o contrato anterior.

Regressão SQL em um PostgreSQL descartável: defina `TEST_DATABASE_URL` e execute
`node -r ts-node/register/transpile-only test/conversations-search.integration.ts`
na pasta da API. O teste cria somente tabelas temporárias e cobre paginação
além de 150 registros, isolamento de empresas, contadores e filtros.

## Gemini Live no Flow

O Flow salva modelo, voz e detecção automática de fala em `metadata.gemini_live`
do cliente. A seleção explícita do Flow prevalece sobre o motor legado do agente;
overrides internos de telefonia continuam tendo prioridade. As configurações são
aplicadas nas próximas chamadas após salvar, tanto no navegador quanto na telefonia.
Clientes sem essa configuração mantêm o comportamento anterior.

O seletor oferece `gemini-3.8-live` e o legado `gemini-3.1-flash-live-preview`.
O backend valida e limita os valores de VAD antes de montar o setup. Transcrições
de entrada e saída permanecem ativas para o histórico. Gemini 3.8 não recebe
`thinkingConfig`, `enableAffectiveDialog` ou desativação de áudio proativo.
As ferramentas usam `behavior: BLOCKING` para preservar a execução sequencial
existente. A variante Extended Thinking não é oferecida: sua execução assíncrona
exige adaptar o acompanhamento de interação antes de habilitá-la.

Referências consultadas em 24/09/2026:
[modelo e migração](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live?hl=pt-br)
e [recursos da Live API](https://ai.google.dev/gemini-api/docs/live-api/capabilities?hl=pt-br).

### Abertura, inatividade e provedores no Flow

`metadata.voice_behavior` permite definir `greetingCacheEnabled`, `idleEnabled`
e `turns: [{ text, waitSeconds, endCall }]`. A preferência de cache do Flow
sobrescreve a do agente; ausente, preserva o comportamento anterior. A sequência
aceita até 100 turnos de 5–600 segundos e texto de até 1.000 caracteres. Turnos
vazios são ignorados; o primeiro `endCall: true` termina a sequência. Sem turno
final, a chamada permanece aberta após a última mensagem.

Também aceita `greetingMessage` (até 6.000 caracteres, com variáveis e variações
separadas por uma linha `---`) e `aiSpeaksFirst` (booleano opcional). Mensagem
vazia usa a configuração do agente; preenchida, substitui a saudação e suas
variações somente na sessão, sem modificar o cadastro do agente. A substituição
vale tanto para cache quanto para a geração normal, no navegador e na telefonia.

O controlador é compartilhado pela telefonia e pelo navegador, para Gemini,
Cartesia/Groq e endpoints próprios. A atividade do usuário reinicia a sequência;
a espera leva em conta a reprodução de áudio PCM24k. A fala é solicitada ao motor
ativo com o texto configurado. Falha de geração tem watchdog de 60 segundos e é
registrada; em um turno final, a chamada é encerrada mesmo nessa falha. O cache
da primeira fala considera o texto interpolado, modelo, voz, idioma, empresa e
endpoint. Gemini usa `gemini-3.8-flash-tts` para sintetizar essa abertura; a geração
inicial tem cobrança TTS própria e falhas usam o fluxo normal de saudação.

`metadata.voice_settings` configura `cartesiaVoice`, `cartesiaModel`, `groqModel`,
`language`, `sttPrompt` e `customTtsVoice`. Segredos e endpoints continuam nas
integrações existentes. Valores de modelo/idioma são limitados no backend.

O catálogo de vozes Gemini destaca overhead por turno, com estimativas fornecidas
pelo usuário em 24/09/2026, sem garantia de equivalência no modelo 3.8. A tarifa
oficial é separada dessas estimativas. Flare e Vega são exibidas apenas no
comparativo, pois não constam nas vozes predefinidas da documentação consultada.
Algieba segue o gênero masculino do [catálogo oficial](https://firebase.google.com/docs/ai-logic/generate-speech).


### OpenAI como provedor LLM

Em Configurações > Provedores, cadastre a chave OpenAI, carregue os modelos e
habilite aqueles que serão usados pelos agentes (incluindo o editor do Flow) e
subagentes. O teste de conexão usa o primeiro modelo habilitado ou `gpt-4.1-mini`.
A chave utiliza o mesmo armazenamento criptografado e escopo de cliente dos demais
provedores. No servidor, `OPENAI_API_KEY` e `OPENAI_MODEL` são alternativas de configuração.

A integração direta usa a Responses API, com streaming, ferramentas, imagens e
contabilização de tokens entre chamadas. As respostas não são armazenadas pela API
(`store: false`); o estado de raciocínio criptografado é mantido durante o loop de
ferramentas. Modelos de raciocínio usam seus parâmetros padrão, sem temperatura.
A listagem exclui modelos de áudio, imagem, embeddings e variantes especializadas;
a disponibilidade efetiva depende da conta OpenAI. Anexos de áudio no chat continuam
usando a credencial Groq de transcrição, separadamente da credencial OpenAI.

Referências: https://developers.openai.com/api/docs/guides/function-calling e
https://developers.openai.com/api/docs/guides/streaming-responses.


### Inworld TTS/STT no pipeline de voz

Cadastre a credencial Basic da Inworld em Configurações > Provedores > Inworld.
O teste de conexão valida acesso ao catálogo de vozes; não realiza síntese nem
transcrição faturáveis e não garante permissão de escrita nesses endpoints.
`INWORLD_API_KEY` é a alternativa por variável de ambiente.

No Flow, selecione o modo híbrido e escolha separadamente **Inworld TTS-2 Flash**
e/ou **Inworld STT-1**. O ID da voz é configurável (padrão `Mariana`). As escolhas
salvas no Flow prevalecem sobre os provedores do agente; sem essas escolhas,
valem os provedores do agente. O idioma selecionado é enviado como dica ao STT.

O TTS usa HTTP streaming NDJSON, com PCM16 mono a 24 kHz e cancelamento no barge-in.
O STT usa `inworld/inworld-stt-1` por turno de fala (PCM16 mono a 16 kHz), após o
VAD local; não usa ainda a sessão WebSocket contínua da Inworld.
Cache da saudação, configuração da fala inicial, turnos de inatividade e
encerramento automático são compartilhados com os demais provedores.
Chave ausente gera erro explícito; não há fallback silencioso para Cartesia/Groq.

Contratos oficiais:
- https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-stream
- https://docs.inworld.ai/api-reference/sttAPI/speechtotext/transcribe


### Entrega e retenção de chamadas

O evento `call.completed` permite entregar os dados ao cliente e remover o conteúdo após confirmação ou expiração. Configuração, contrato HMAC, limites e publicação: [docs/call-data-delivery.md](docs/call-data-delivery.md).
