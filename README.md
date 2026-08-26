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
