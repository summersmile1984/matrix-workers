# Development Guide

Complete guide to setting up a local development environment and self-hosted deployment for matrix-workers.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Development Modes](#development-modes)
  - [Cloudflare Workers (wrangler dev)](#cloudflare-workers-wrangler-dev)
  - [Self-Hosted (Bun + libSQL)](#self-hosted-bun--libsql)
- [Docker Compose Services](#docker-compose-services)
- [Environment Variables Reference](#environment-variables-reference)
- [npm Scripts](#npm-scripts)
- [Database Migrations](#database-migrations)
- [Adapters & Service Mapping](#adapters--service-mapping)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **Node.js 18+** | Both modes | [nodejs.org](https://nodejs.org) |
| **Bun** | Self-hosted | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | Self-hosted (sqld, LiveKit, Coturn) | [docs.docker.com](https://docs.docker.com/get-docker/) |
| **Wrangler** | CF Workers | `npm install -g wrangler` |

---

## Project Structure

```
matrix-workers/
├── src/
│   ├── index.ts                 # Main Hono app (shared by both modes)
│   ├── server.ts                # Self-hosted entry point (Bun + libSQL)
│   ├── preload.ts               # Bun plugin shim for cloudflare:workers module
│   ├── api/                     # Matrix API route handlers
│   ├── services/                # Business logic
│   ├── adapters/                # Platform abstraction layer
│   │   ├── d1-adapter.ts        #   libSQL → D1 API shim
│   │   ├── kv-adapter.ts        #   libSQL → KV API shim
│   │   ├── do-namespace-adapter.ts  # In-process Durable Object shim
│   │   ├── do-storage-adapter.ts    # libSQL-backed DO storage
│   │   ├── fs-media-storage.ts  #   Filesystem → R2 API shim
│   │   ├── email-adapter.ts     #   Resend → CF Email shim
│   │   ├── ai-adapter.ts        #   Chutes → Workers AI shim
│   │   ├── mastra-workflow-adapter.ts  # Mastra → CF Workflows shim
│   │   └── media-storage.ts     #   MediaStorage interface
│   ├── durable-objects/         # Durable Object classes
│   ├── workflows/               # Cloudflare Workflows
│   ├── types/                   # TypeScript types (env.ts etc.)
│   └── middleware/              # Auth, rate limiting, analytics
├── migrations/                  # SQL migrations (D1 & libSQL)
├── scripts/
│   ├── self-hosted.sh           # Self-hosted management script
│   ├── migrate-libsql.ts        # libSQL migration runner
│   └── create-test-users.sh     # Test user creation script
├── tests/                       # Test files
├── public/                      # Static assets (Synapse Admin UI)
├── docker-compose.yml           # Dev services (Redis, LiveKit, Coturn)
├── livekit.yaml                 # LiveKit server configuration
├── setup.sh                     # Cloudflare resource provisioning
├── wrangler.jsonc               # Cloudflare Workers configuration
├── .env.local                   # Self-hosted environment (git-ignored)
└── package.json
```

---

## Development Modes

### Cloudflare Workers (wrangler dev)

Uses wrangler's local dev server with simulated D1, KV, R2, and Durable Objects.

```bash
npm install
npm run dev          # Start wrangler dev server at http://localhost:8787
```

Entry point: `src/index.ts` (via `wrangler.jsonc` `main` field)

### Self-Hosted (Bun + libSQL)

Runs the full server on Bun with libSQL replacing D1/KV, filesystem replacing R2, and in-process Durable Objects.

#### Quick Start

```bash
# One-command setup (creates .env.local, starts sqld, runs migrations, starts server)
npm run self-hosted init
```

#### Manual Start

```bash
# 1. Start libSQL server (Docker)
docker run -d --name matrix-sqld --restart unless-stopped \
  -p 8080:8080 -v $(pwd)/.data/sqld:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest

# 2. Run migrations
LIBSQL_URL=http://localhost:8080 bun run scripts/migrate-libsql.ts

# 3. Start server (loads .env.local automatically)
bun run src/preload.ts
```

#### Management Commands

```bash
npm run self-hosted start     # Start sqld + Matrix server
npm run self-hosted stop      # Stop Matrix server (optionally sqld)
npm run self-hosted restart   # Restart Matrix server
npm run self-hosted status    # Show service health
npm run self-hosted logs      # Tail server log
npm run self-hosted migrate   # Re-run migrations (idempotent)
```

Entry point: `src/preload.ts` → `src/server.ts`

The preload script registers a Bun plugin that shims the `cloudflare:workers` module, so Durable Object and Workflow classes can import it without code changes.

---

## Docker Compose Services

`docker-compose.yml` provides three services for local development:

```bash
docker compose up -d            # Start all services
docker compose down             # Stop all services
docker compose logs -f livekit  # Tail specific service
```

| Service | Container | Ports | Purpose |
|---------|-----------|-------|---------|
| **Redis** | `matrix-redis` | `6379` | LiveKit state backend |
| **LiveKit** | `matrix-livekit` | `7880` (WS), `7881` (TCP), `50000-50100/udp` (RTC) | SFU for video/voice calls |
| **Coturn** | `matrix-coturn` | `3478` (TURN), `5349` (TURNS), `49152-49200/udp` (relay) | TURN/STUN for NAT traversal |

### LiveKit Configuration

LiveKit reads from `livekit.yaml` (mounted as `/etc/livekit.yaml` in the container):

```yaml
# Default dev credentials
keys:
  devkey: secret     # API key: devkey, API secret: secret

# RTC port range (must match docker-compose port mapping)
rtc:
  port_range_start: 50000
  port_range_end: 60000
```

To match `.env.local`:
```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Coturn Configuration

Coturn uses `COTURN_SECRET` for TURN authentication:

```env
COTURN_SECRET=my-local-turn-secret
```

---

## Environment Variables Reference

All configuration is in `.env.local` for self-hosted mode. For Cloudflare, use `wrangler.jsonc` `vars` + `wrangler secret put`.

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `SERVER_NAME` | `localhost:8787` | Matrix server name (cannot change after users register) |
| `LIBSQL_URL` | `http://localhost:8080` | libSQL server URL (self-hosted only) |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | HTTP listen port |
| `LIBSQL_PORT` | `8080` | sqld Docker container port |
| `LIBSQL_TOKEN` | *(empty)* | libSQL auth token (empty for local dev) |
| `SERVER_VERSION` | `0.1.0` | Reported server version |

### LiveKit / VoIP

| Variable | Default | Description |
|----------|---------|-------------|
| `LIVEKIT_URL` | *(empty)* | LiveKit WebSocket URL (e.g., `ws://localhost:7880`) |
| `LIVEKIT_API_KEY` | *(empty)* | LiveKit API key |
| `LIVEKIT_API_SECRET` | *(empty)* | LiveKit API secret |
| `COTURN_SECRET` | *(empty)* | Local Coturn shared secret |
| `TURN_KEY_ID` | *(empty)* | Cloudflare TURN key ID (CF deployment only) |
| `TURN_API_TOKEN` | *(empty)* | Cloudflare TURN API token (CF deployment only) |

### Email

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | *(empty)* | [Resend](https://resend.com) API key (self-hosted email adapter) |
| `EMAIL_FROM` | *(empty)* | From address for verification emails |

### AI

| Variable | Default | Description |
|----------|---------|-------------|
| `CHUTES_API_KEY` | *(empty)* | [Chutes AI](https://chutes.ai) API key |
| `CHUTES_API_URL` | *(empty)* | Chutes AI endpoint (e.g., `https://llm.chutes.ai/v1`) |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_ENCRYPTION_KEY` | *(empty)* | OIDC client secret encryption key (`openssl rand -base64 32`) |
| `SIGNING_KEY` | *(auto-generated)* | Server Ed25519 signing key (`ed25519:KEY_ID:BASE64`) |

### Push Notifications (APNs)

| Variable | Default | Description |
|----------|---------|-------------|
| `APNS_KEY_ID` | *(empty)* | Apple Push key ID |
| `APNS_TEAM_ID` | *(empty)* | Apple Developer Team ID |
| `APNS_PRIVATE_KEY` | *(empty)* | Contents of `.p8` file |
| `APNS_ENVIRONMENT` | `sandbox` | `production` or `sandbox` |

### Media

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIA_BACKEND` | `fs` | Storage backend: `fs` (filesystem) |
| `MEDIA_PATH` | `./data/media` | Filesystem path for media files |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOW_E2EE` | `true` | Enable end-to-end encryption |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum upload size in MB |

### Admin / Support

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_CONTACT_EMAIL` | *(empty)* | Admin email (in `/.well-known/matrix/support`) |
| `ADMIN_CONTACT_MXID` | *(empty)* | Admin Matrix ID |
| `SUPPORT_PAGE_URL` | *(empty)* | URL to support/help page |

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `wrangler dev` | Start CF Workers local dev server |
| `deploy` | `wrangler deploy` | Deploy to Cloudflare |
| `start` | `bun run src/preload.ts` | Start self-hosted server (foreground) |
| `dev:local` | `LIBSQL_URL=... bun run src/preload.ts` | Start with hardcoded local env |
| `self-hosted` | `bash scripts/self-hosted.sh --` | Management script (`init` / `start` / `stop` / `status` / `logs` / `migrate`) |
| `db:migrate` | `wrangler d1 execute ...` | Run schema.sql on remote D1 |
| `db:migrate:local` | `wrangler d1 execute ... --local` | Run schema.sql on local D1 |
| `db:migrate:libsql` | `bun run scripts/migrate-libsql.ts` | Run all migrations on libSQL |
| `test` | `vitest` | Run test suite |
| `typecheck` | `tsc --noEmit` | TypeScript type checking |
| `lint` | `eslint src/` | Lint source code |

---

## Database Migrations

Migrations live in `migrations/` and are applied in order. All use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for idempotency.

### Migration Files

| File | Description |
|------|-------------|
| `schema.sql` | Core schema (users, rooms, events, memberships, tokens, etc.) |
| `002_phase1_e2ee.sql` | E2EE key storage tables |
| `002_self_hosted.sql` | KV shim table for self-hosted mode |
| `003_account_management.sql` | Account management (deactivation, etc.) |
| `004_reports_and_notices.sql` | Content reports & server notices |
| `005_server_config.sql` | Server configuration storage |
| `005_idp_providers.sql` | OIDC identity provider tables |
| `006_query_optimization.sql` | Indexes for query performance |
| `007_secure_server_keys.sql` | Server signing key storage |
| `008_federation_transactions.sql` | Federation transaction tracking |
| `009_reports_extended.sql` | Extended report fields |
| `010_fix_reports_schema.sql` | Reports schema fixes |
| `011_identity_service.sql` | Identity service (3PID) tables |
| `012_fts_search.sql` | FTS5 full-text search indexes |
| `013_remote_device_lists.sql` | Remote device list tracking |
| `014_appservice.sql` | Application Service registration |
| `015_identity_associations.sql` | Identity association tables |

### Running Migrations

```bash
# Self-hosted (libSQL) — runs ALL migration files automatically
npm run db:migrate:libsql

# Cloudflare (D1) — run each file individually
npx wrangler d1 execute DB_NAME --remote --file=migrations/schema.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/002_phase1_e2ee.sql
# ... (see DEPLOYMENT.md for full list)
```

---

## Adapters & Service Mapping

The project abstracts platform-specific services through adapters. The same `src/index.ts` runs on both Cloudflare Workers and Bun.

| Service | Cloudflare Workers | Self-Hosted (Bun) |
|---------|-------------------|-------------------|
| **Database** | D1 (SQLite) | libSQL via `LibSQLD1Adapter` |
| **Key-Value** | KV Namespaces | libSQL via `LibSQLKVNamespace` |
| **Object Storage** | R2 Bucket | Filesystem via `FileSystemMediaStorage` |
| **Durable Objects** | Native DO | In-process via `createDONamespace` |
| **Workflows** | CF Workflows | Mastra via `createMastraWorkflowBinding` |
| **Email** | CF Email Service | Resend HTTP API via `ResendEmailAdapter` |
| **AI** | Workers AI | Chutes AI via `ChutesAIAdapter` |
| **LiveKit** | Workers VPC (`LIVEKIT_API` binding) | Direct HTTP fetch to LiveKit URL |
| **TURN** | Cloudflare TURN API | Local Coturn (shared secret auth) |
| **Analytics** | Analytics Engine | *(not available)* |
| **Browser Rendering** | Workers Browser | *(not available)* |

---

## Testing

```bash
# Run unit tests
npm run test

# Type checking
npm run typecheck

# Lint
npm run lint

# Manual API testing against local server
curl http://localhost:8787/_matrix/client/versions
curl http://localhost:8787/health

# Create test users (helper script)
bash scripts/create-test-users.sh
```

### Test Files

| File | Description |
|------|-------------|
| `tests/test-livekit.ts` | LiveKit JWT token generation tests |

---

## Troubleshooting

### Self-Hosted

**sqld won't start**
```bash
docker logs matrix-sqld --tail=20
# Common fix: remove stale data
rm -rf .data/sqld && npm run self-hosted init
```

**"LIBSQL_URL is required"**
```bash
# Ensure .env.local has LIBSQL_URL set
cat .env.local | grep LIBSQL_URL
# Or source it manually
source .env.local && bun run src/preload.ts
```

**Port already in use**
```bash
lsof -i :8787   # Find process on Matrix port
lsof -i :8080   # Find process on sqld port
kill <PID>
```

**LiveKit "connection refused"**
```bash
# Check LiveKit is running
docker compose ps
# Restart LiveKit
docker compose restart livekit
# Check logs
docker compose logs -f livekit
```

### Cloudflare Workers

**"Workers Paid plan required"**
Durable Objects require Workers Paid ($5/month). Upgrade in Cloudflare Dashboard → Workers & Pages → Plans.

**Deployment fails with binding errors**
Ensure all resource IDs in `wrangler.jsonc` match actual Cloudflare resources. Re-run `setup.sh` if needed.

**View live logs**
```bash
npx wrangler tail
```

---

## Related Docs

- [SELF-HOSTED.md](./SELF-HOSTED.md) — Self-hosted deployment guide (dev + production)
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Cloudflare Workers production deployment guide
- [README.md](./README.md) — Project overview and API reference
