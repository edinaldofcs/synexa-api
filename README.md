# Synexa API

Backend NestJS do painel Synexa. Suporta dois modos de execução controlados pela variável `ENVIRONMENT`:

| Modo | `ENVIRONMENT` | Auth | Storage | Banco |
|---|---|---|---|---|
| Desenvolvimento | `development` | Sessão local em cookie HttpOnly | Disco local (`./uploads/`) | PostgreSQL local (Docker) |
| Produção | `production` | Supabase Auth + sessão em cookie HttpOnly | Supabase Storage | Supabase Pooler |

## Setup Desenvolvimento

### Pré-requisitos

- Docker Desktop
- Node.js 20+

### 1. Subir dependências

```bash
docker compose -f docker-compose.dev.yml up -d db redis
```

### 2. Instalar pacotes

```bash
npm install
```

### 3. Sincronizar schema com o banco

```bash
npx prisma db push --accept-data-loss
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
