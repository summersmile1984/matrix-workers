# Self-Hosted Deployment Guide

Run matrix-workers outside of Cloudflare using **Bun** + **libSQL**. This guide covers both local development and production deployment.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Part 1: Development Environment](#part-1-development-environment)
  - [Prerequisites](#prerequisites)
  - [Quick Start](#quick-start)
  - [Docker Compose Services](#docker-compose-services)
  - [Management Commands](#management-commands)
- [Part 2: Production Deployment](#part-2-production-deployment)
  - [System Requirements](#system-requirements)
  - [Installation](#installation)
  - [Reverse Proxy (Nginx)](#reverse-proxy-nginx)
  - [SSL/TLS Certificates](#ssltls-certificates)
  - [Process Management (systemd)](#process-management-systemd)
  - [LiveKit Production Setup](#livekit-production-setup)
  - [Coturn Production Setup](#coturn-production-setup)
  - [Backups](#backups)
  - [Monitoring](#monitoring)
- [Environment Variables Reference](#environment-variables-reference)
- [Database Migrations](#database-migrations)
- [Platform Adapter Mapping](#platform-adapter-mapping)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Self-Hosted Architecture                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                    │
│  │  Bun Server   │    │   libSQL      │    │  Filesystem   │                   │
│  │  (Hono app)   │───▶│  (sqld)       │    │  Media Store   │                  │
│  │  port 8787    │    │  port 8080    │    │  ./data/media  │                  │
│  └──────┬───────┘    └──────────────┘    └──────────────┘                    │
│         │                                                                    │
│  ┌──────┴───────┐    ┌──────────────┐    ┌──────────────┐                    │
│  │  In-Process   │    │   LiveKit     │    │   Coturn      │                   │
│  │  Durable Objs │    │  port 7880    │    │  port 3478    │                   │
│  │  + Mastra WF  │    │  (optional)   │    │  (optional)   │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Key differences from Cloudflare Workers mode:

| Component | Cloudflare | Self-Hosted |
|-----------|-----------|-------------|
| Database | D1 (SQLite) | libSQL (sqld Docker container) |
| Key-Value | KV Namespaces | libSQL tables via `LibSQLKVNamespace` |
| Media Storage | R2 Bucket | Filesystem (`./data/media`) |
| Durable Objects | Native DO | In-process with libSQL storage |
| Workflows | CF Workflows | Mastra workflow engine |
| Email | CF Email Service | Resend HTTP API |
| AI | Workers AI | Chutes AI HTTP API |
| TURN | Cloudflare TURN | Coturn (Docker) |

---

# Part 1: Development Environment

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Bun** | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org) |
| **Docker** | 20+ | [docs.docker.com](https://docs.docker.com/get-docker/) |

## Quick Start

```bash
# Clone and install
git clone https://github.com/nkuntz1934/matrix-workers
cd matrix-workers
npm install

# One-command setup: creates .env.local, starts sqld, runs migrations, starts server
npm run self-hosted init
```

This will:
1. ✅ Check prerequisites (bun, docker, node)
2. ✅ Generate `.env.local` with default values
3. ✅ Install npm dependencies
4. ✅ Start sqld (libSQL server) in Docker
5. ✅ Run all database migrations
6. ✅ Start the Matrix homeserver on `http://localhost:8787`

### Verify

```bash
# Health check
curl http://localhost:8787/health

# Matrix versions
curl http://localhost:8787/_matrix/client/versions

# Register first user
curl -X POST http://localhost:8787/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"yourpassword","auth":{"type":"m.login.dummy"}}'
```

## Docker Compose Services

Optional services for video calling and TURN:

```bash
# Start Redis + LiveKit + Coturn
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f livekit
```

| Service | Container | Ports | Description |
|---------|-----------|-------|-------------|
| **Redis** | `matrix-redis` | `6379` | LiveKit state backend |
| **LiveKit** | `matrix-livekit` | `7880` (WS), `7881` (TCP), `50000-50100/udp` (RTC) | Video/voice SFU |
| **Coturn** | `matrix-coturn` | `3478` (TURN), `5349` (TURNS), `49152-49200/udp` (relay) | NAT traversal |

### LiveKit Dev Config

LiveKit reads `livekit.yaml` (mounted into the container):

```yaml
keys:
  devkey: secret       # Default dev credentials

rtc:
  port_range_start: 50000
  port_range_end: 60000
```

Matching `.env.local`:
```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Coturn Dev Config

```env
COTURN_SECRET=my-local-turn-secret
```

The Coturn container starts with `--static-auth-secret=my-local-turn-secret` by default.

## Management Commands

All via `npm run self-hosted <command>`:

| Command | Description |
|---------|-------------|
| `init` | First-time setup (install deps, start sqld, migrate, start server) |
| `start` | Start sqld + Matrix server |
| `stop` | Stop Matrix server (prompts to also stop sqld) |
| `restart` | Stop + start Matrix server |
| `status` | Show health of sqld and Matrix server |
| `logs` | Tail server log (`~/.run/matrix-server.log`) |
| `migrate` | Re-run database migrations (idempotent) |

### Direct Commands

```bash
# Start server in foreground (for debugging)
source .env.local
bun run src/preload.ts

# Run migrations manually
LIBSQL_URL=http://localhost:8080 bun run scripts/migrate-libsql.ts

# Start with custom env
LIBSQL_URL=http://localhost:8080 SERVER_NAME=localhost:8787 bun run src/preload.ts
```

---

# Part 2: Production Deployment

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **CPU** | 2 cores | 4 cores |
| **RAM** | 2 GB | 4 GB |
| **Disk** | 20 GB | 100 GB+ (depends on media) |
| **OS** | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 |
| **Network** | Public IP with ports 443, 3478 | Dedicated IP |

## Installation

### 1. Install Dependencies

```bash
# Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js (for npm)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone and Setup

```bash
cd /opt
sudo git clone https://github.com/nkuntz1934/matrix-workers
sudo chown -R $USER:$USER matrix-workers
cd matrix-workers
npm install --production
```

### 3. Configure Environment

```bash
cp .env.local.example .env.local   # Or let init generate it
# Edit .env.local with production values
nano .env.local
```

**Critical production settings:**

```env
# ── Required ──────────────────────────────────────────────
SERVER_NAME=matrix.yourdomain.com    # Your Matrix domain (CANNOT change after users register)
LIBSQL_URL=http://localhost:8080
PORT=8787

# ── Security ──────────────────────────────────────────────
SIGNING_KEY=                         # Leave empty on first start, auto-generated
OIDC_ENCRYPTION_KEY=                 # Generate: openssl rand -base64 32
ALLOW_E2EE=true

# ── LiveKit (if using video calls) ────────────────────────
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=your-production-key
LIVEKIT_API_SECRET=your-production-secret

# ── TURN (if using Coturn) ────────────────────────────────
COTURN_SECRET=your-strong-random-secret

# ── Email ─────────────────────────────────────────────────
RESEND_API_KEY=re_xxxxx
EMAIL_FROM=noreply@yourdomain.com

# ── Admin ─────────────────────────────────────────────────
ADMIN_CONTACT_EMAIL=admin@yourdomain.com
ADMIN_CONTACT_MXID=@admin:matrix.yourdomain.com
SUPPORT_PAGE_URL=https://yourdomain.com/support
```

### 4. Initialize

```bash
npm run self-hosted init
```

### 5. Verify

```bash
curl http://localhost:8787/_matrix/client/versions
curl http://localhost:8787/.well-known/matrix/server
```

## Reverse Proxy (Nginx)

Matrix requires HTTPS. Place Nginx in front of the Bun server.

### Install Nginx

```bash
sudo apt-get install -y nginx
```

### Matrix Server Config

```nginx
# /etc/nginx/sites-available/matrix
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name matrix.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/matrix.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/matrix.yourdomain.com/privkey.pem;

    # Matrix spec recommends large uploads
    client_max_body_size 50M;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for long-poll sync)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeout for long-poll sync (Matrix clients use 30s timeout)
        proxy_read_timeout 120s;
    }
}

# HTTP redirect
server {
    listen 80;
    listen [::]:80;
    server_name matrix.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

### Federation Port 8448 (Optional)

If you need federation on port 8448 (some servers check this):

```nginx
server {
    listen 8448 ssl http2;
    listen [::]:8448 ssl http2;
    server_name matrix.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/matrix.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/matrix.yourdomain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Enable Site

```bash
sudo ln -s /etc/nginx/sites-available/matrix /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## SSL/TLS Certificates

### Let's Encrypt (Recommended)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d matrix.yourdomain.com

# Auto-renewal is set up automatically
sudo systemctl enable certbot.timer
```

### DNS Records

| Type | Name | Content |
|------|------|---------|
| `A` | `matrix` | `your-server-ip` |
| `AAAA` | `matrix` | `your-ipv6` *(optional)* |
| `SRV` | `_matrix._tcp.yourdomain.com` | `0 10 443 matrix.yourdomain.com` *(optional)* |

## Process Management (systemd)

### Matrix Homeserver Service

```ini
# /etc/systemd/system/matrix-workers.service
[Unit]
Description=Matrix Workers Homeserver
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=matrix
Group=matrix
WorkingDirectory=/opt/matrix-workers
EnvironmentFile=/opt/matrix-workers/.env.local
ExecStartPre=/usr/bin/docker start matrix-sqld
ExecStartPre=/bin/sleep 3
ExecStart=/usr/local/bin/bun run src/preload.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/matrix-workers/.data /opt/matrix-workers/data /opt/matrix-workers/.run

[Install]
WantedBy=multi-user.target
```

### Enable and Start

```bash
# Create matrix user
sudo useradd -r -s /bin/false -d /opt/matrix-workers matrix
sudo chown -R matrix:matrix /opt/matrix-workers

# Enable services
sudo systemctl daemon-reload
sudo systemctl enable matrix-workers
sudo systemctl start matrix-workers

# Check status and logs
sudo systemctl status matrix-workers
sudo journalctl -u matrix-workers -f
```

### sqld Service (Alternative to Docker)

If you prefer systemd over Docker for sqld:

```ini
# /etc/systemd/system/matrix-sqld.service
[Unit]
Description=libSQL Server (sqld) for Matrix Workers
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm \
  --name matrix-sqld \
  -p 8080:8080 \
  -v /opt/matrix-workers/.data/sqld:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## LiveKit Production Setup

### Generate Production Keys

```bash
# Generate a strong API key and secret
openssl rand -hex 16   # Use as API key
openssl rand -hex 32   # Use as API secret
```

### Production `livekit.yaml`

```yaml
port: 7880
bind_addresses:
    - ""
rtc:
    tcp_port: 7881
    port_range_start: 50000
    port_range_end: 60000
    use_external_ip: true          # Changed: use real IP in production
    stun_servers:
        - "stun.l.google.com:19302"
redis:
    address: redis:6379
turn:
    enabled: true
    domain: turn.yourdomain.com    # Your TURN domain
    cert_file: /etc/livekit/cert.pem
    key_file: /etc/livekit/key.pem
    tls_port: 5349
    udp_port: 3478
keys:
    YOUR_API_KEY: YOUR_API_SECRET   # Replace with generated values
```

### LiveKit Nginx Proxy

```nginx
# /etc/nginx/sites-available/livekit
server {
    listen 443 ssl http2;
    server_name livekit.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/livekit.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/livekit.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

Update `.env.local`:
```env
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=your-production-key
LIVEKIT_API_SECRET=your-production-secret
```

## Coturn Production Setup

### Production docker-compose Override

Create `docker-compose.prod.yml`:

```yaml
services:
  coturn:
    image: coturn/coturn:latest
    container_name: matrix-coturn
    network_mode: host
    command:
      - -n
      - --log-file=stdout
      - --min-port=49152
      - --max-port=49200
      - --use-auth-secret
      - --static-auth-secret=${COTURN_SECRET}
      - --realm=yourdomain.com
      - --cert=/etc/coturn/cert.pem
      - --pkey=/etc/coturn/key.pem
      - --external-ip=${EXTERNAL_IP}
      - --listening-ip=0.0.0.0
    volumes:
      - /etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem:/etc/coturn/cert.pem:ro
      - /etc/letsencrypt/live/turn.yourdomain.com/privkey.pem:/etc/coturn/key.pem:ro
    restart: unless-stopped
```

```bash
EXTERNAL_IP=$(curl -4 ifconfig.me) docker compose -f docker-compose.prod.yml up -d coturn
```

### Coturn DNS Records

| Type | Name | Content |
|------|------|---------|
| `A` | `turn` | `your-server-ip` |
| `SRV` | `_turn._udp.yourdomain.com` | `0 0 3478 turn.yourdomain.com` |
| `SRV` | `_turn._tcp.yourdomain.com` | `0 0 3478 turn.yourdomain.com` |

### Firewall Rules

```bash
# Matrix HTTPS
sudo ufw allow 443/tcp

# Federation (optional)
sudo ufw allow 8448/tcp

# Coturn TURN
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:49200/udp

# LiveKit RTC (if on same server)
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
```

## Backups

### Database Backup

```bash
# Backup sqld data directory
tar -czf matrix-backup-$(date +%Y%m%d).tar.gz \
  /opt/matrix-workers/.data/sqld \
  /opt/matrix-workers/data/media \
  /opt/matrix-workers/.env.local

# Or use libSQL HTTP API to export
curl http://localhost:8080/dump > matrix-db-dump.sql
```

### Automated Backup Script

```bash
#!/bin/bash
# /opt/matrix-workers/scripts/backup.sh
BACKUP_DIR="/var/backups/matrix"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# Stop writes briefly
docker pause matrix-sqld

# Backup
tar -czf "$BACKUP_DIR/matrix-$DATE.tar.gz" \
  /opt/matrix-workers/.data/sqld \
  /opt/matrix-workers/data/media

# Resume
docker unpause matrix-sqld

# Keep last 7 days
find "$BACKUP_DIR" -name "matrix-*.tar.gz" -mtime +7 -delete
echo "[backup] Done: matrix-$DATE.tar.gz"
```

Add to cron:
```bash
# Daily at 3 AM
echo "0 3 * * * /opt/matrix-workers/scripts/backup.sh" | crontab -
```

## Monitoring

### Health Check Endpoints

```bash
# Matrix server
curl -sf http://localhost:8787/health

# sqld
curl -sf http://localhost:8080/health

# Federation verification
curl -sf https://matrix.yourdomain.com/_matrix/federation/v1/version
```

### Uptime Monitoring Script

```bash
#!/bin/bash
# Check both services are healthy
if ! curl -sf http://localhost:8787/health > /dev/null; then
    echo "[ALERT] Matrix server is DOWN" | mail -s "Matrix Alert" admin@yourdomain.com
    systemctl restart matrix-workers
fi

if ! curl -sf http://localhost:8080/health > /dev/null; then
    echo "[ALERT] sqld is DOWN" | mail -s "sqld Alert" admin@yourdomain.com
    docker restart matrix-sqld
fi
```

---

## Environment Variables Reference

See [DEVELOPMENT.md — Environment Variables Reference](./DEVELOPMENT.md#environment-variables-reference) for the complete list.

**Production checklist:**

- [x] `SERVER_NAME` — Set to your production domain
- [x] `SIGNING_KEY` — Auto-generated on first start; **back this up**
- [x] `OIDC_ENCRYPTION_KEY` — Generate with `openssl rand -base64 32`
- [x] `COTURN_SECRET` — Strong random secret (`openssl rand -hex 32`)
- [x] `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — Production credentials
- [x] `RESEND_API_KEY` — If using email verification
- [x] `EMAIL_FROM` — Verified sender address
- [x] `ALLOW_E2EE` — Set to `true` for production

---

## Database Migrations

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`).

```bash
# Run all migrations (self-hosted)
npm run db:migrate:libsql

# Or manually
LIBSQL_URL=http://localhost:8080 bun run scripts/migrate-libsql.ts
```

The migration runner executes files in this order:
1. `schema.sql` (base tables)
2. Numbered migrations (`002_` through `015_`) alphabetically
3. `002_self_hosted.sql` (KV shim table, always last)

---

## Platform Adapter Mapping

| Service | Cloudflare | Self-Hosted Adapter | Source |
|---------|-----------|-------------------|--------|
| Database | D1 | `LibSQLD1Adapter` | `src/adapters/d1-adapter.ts` |
| Key-Value | KV | `LibSQLKVNamespace` | `src/adapters/kv-adapter.ts` |
| Media | R2 | `FileSystemMediaStorage` | `src/adapters/fs-media-storage.ts` |
| Durable Objects | Native | `createDONamespace` | `src/adapters/do-namespace-adapter.ts` |
| DO Storage | Native | libSQL-backed | `src/adapters/do-storage-adapter.ts` |
| Workflows | CF Workflows | Mastra engine | `src/adapters/mastra-workflow-adapter.ts` |
| Email | CF Email | `ResendEmailAdapter` | `src/adapters/email-adapter.ts` |
| AI | Workers AI | `ChutesAIAdapter` | `src/adapters/ai-adapter.ts` |

Entry points:
- **Cloudflare**: `src/index.ts` (loaded by Wrangler)
- **Self-Hosted**: `src/preload.ts` → `src/server.ts` → imports `src/index.ts`

---

## Troubleshooting

### Server won't start

```bash
# Check if port is in use
lsof -i :8787

# Check sqld is reachable
curl http://localhost:8080/health

# Run in foreground for error details
source .env.local && bun run src/preload.ts
```

### sqld container issues

```bash
# Check container logs
docker logs matrix-sqld --tail=50

# Reset database (WARNING: deletes all data)
docker rm -f matrix-sqld
rm -rf .data/sqld
npm run self-hosted init
```

### Federation not working

1. Check DNS resolves: `dig matrix.yourdomain.com`
2. Check `.well-known`: `curl https://matrix.yourdomain.com/.well-known/matrix/server`
3. Check signing keys: `curl https://matrix.yourdomain.com/_matrix/key/v2/server`
4. Use [Federation Tester](https://federationtester.matrix.org): `https://federationtester.matrix.org/#matrix.yourdomain.com`
5. Check Nginx logs: `sudo tail -f /var/log/nginx/error.log`

### LiveKit calls not connecting

```bash
# Verify LiveKit is running
curl http://localhost:7880

# Check WebSocket upgrade works (through Nginx)
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  https://livekit.yourdomain.com/

# Check port forwarding (RTC/UDP)
sudo ss -ulnp | grep 50000
```

### Memory issues

```bash
# Check Bun memory usage
ps aux | grep bun

# If OOM, increase swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

---

## Related Docs

- [README.md](./README.md) — Project overview and API reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Cloudflare Workers production deployment
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Development environment and project structure
