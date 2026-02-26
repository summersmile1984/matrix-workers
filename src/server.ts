// Self-hosted entry point for matrix-workers
// Run with: bun run src/server.ts
//
// Required environment variables:
//   LIBSQL_URL    - libSQL server URL, e.g. http://localhost:8080
//   SERVER_NAME   - Matrix server name, e.g. matrix.example.com
//
// Optional:
//   LIBSQL_TOKEN         - Auth token for libSQL server (leave empty for local dev)
//   PORT                 - HTTP port (default: 8787)
//   SERVER_VERSION       - Server version string
//   LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL
//   TURN_KEY_ID / TURN_API_TOKEN
//   OIDC_ENCRYPTION_KEY
//   APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY / APNS_ENVIRONMENT
//
// Note: wrangler.jsonc is NOT used in self-hosted mode.
// Cloudflare deployment: npm run dev / npm run deploy
// Self-hosted deployment: npm run dev:local / npm start

import { createClient, type Client } from '@libsql/client/http';

import app from './index';

import { LibSQLD1Adapter } from './adapters/d1-adapter';
import { LibSQLKVNamespace } from './adapters/kv-adapter';
import { createDONamespace } from './adapters/do-namespace-adapter';

import { RoomDurableObject } from './durable-objects/RoomDurableObject';
import { SyncDurableObject } from './durable-objects/SyncDurableObject';
import { FederationDurableObject } from './durable-objects/FederationDurableObject';
import { AdminDurableObject } from './durable-objects/AdminDurableObject';
import { UserKeysDurableObject } from './durable-objects/UserKeysDurableObject';
import { PushDurableObject } from './durable-objects/PushDurableObject';
import { RateLimitDurableObject } from './durable-objects/RateLimitDurableObject';
import { CallRoomDurableObject } from './durable-objects/call-room';

// ── Validate required env vars ────────────────────────────────────────────────

if (!process.env.LIBSQL_URL) {
    throw new Error('[server] LIBSQL_URL environment variable is required. Example: http://localhost:8080');
}
if (!process.env.SERVER_NAME) {
    throw new Error('[server] SERVER_NAME environment variable is required. Example: matrix.example.com');
}

const LIBSQL_URL = process.env.LIBSQL_URL;
const LIBSQL_TOKEN = process.env.LIBSQL_TOKEN; // optional

// ── libSQL connection ─────────────────────────────────────────────────────────

const client: Client = createClient({ url: LIBSQL_URL, authToken: LIBSQL_TOKEN });

// ── Build env object ──────────────────────────────────────────────────────────
// This object mirrors the Cloudflare Workers env injected by wrangler.jsonc.
// DO namespaces are added last because they need a reference to the full env.

const env: any = {
    // ── D1 (main relational database) ────────────────────────────────────────
    DB: new LibSQLD1Adapter(client),

    // ── KV namespaces ────────────────────────────────────────────────────────
    SESSIONS: new LibSQLKVNamespace(client, 'SESSIONS'),
    DEVICE_KEYS: new LibSQLKVNamespace(client, 'DEVICE_KEYS'),
    CACHE: new LibSQLKVNamespace(client, 'CACHE'),
    CROSS_SIGNING_KEYS: new LibSQLKVNamespace(client, 'CROSS_SIGNING_KEYS'),
    ACCOUNT_DATA: new LibSQLKVNamespace(client, 'ACCOUNT_DATA'),
    ONE_TIME_KEYS: new LibSQLKVNamespace(client, 'ONE_TIME_KEYS'),

    // ── R2 (media) ── stub; implement MinIO adapter separately ───────────────
    MEDIA: null,

    // ── Environment variables (mirrors wrangler.jsonc vars + secrets) ─────────
    SERVER_NAME: process.env.SERVER_NAME,
    SERVER_VERSION: process.env.SERVER_VERSION || '0.1.0',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    TURN_KEY_ID: process.env.TURN_KEY_ID,
    TURN_API_TOKEN: process.env.TURN_API_TOKEN,
    OIDC_ENCRYPTION_KEY: process.env.OIDC_ENCRYPTION_KEY,
    APNS_KEY_ID: process.env.APNS_KEY_ID,
    APNS_TEAM_ID: process.env.APNS_TEAM_ID,
    APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
    APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT,
    EMAIL_FROM: process.env.EMAIL_FROM,
    ADMIN_CONTACT_EMAIL: process.env.ADMIN_CONTACT_EMAIL,
    ADMIN_CONTACT_MXID: process.env.ADMIN_CONTACT_MXID,
    SUPPORT_PAGE_URL: process.env.SUPPORT_PAGE_URL,
    SIGNING_KEY: process.env.SIGNING_KEY,

    // ── CF-specific bindings that have no self-hosted equivalent ─────────────
    LIVEKIT_API: null,   // CF VPC service — use LIVEKIT_URL + fetch() directly
    ANALYTICS: null,   // CF Analytics Engine — not available
    AI: null,   // Workers AI — not available
    EMAIL: null,   // CF Email Service — use SMTP instead (future)
    BROWSER: null,   // Browser Rendering — not available

    // ── Workflow stubs (degrade gracefully) ───────────────────────────────────
    // TODO: replace with BullMQ or similar for production async jobs
    ROOM_JOIN_WORKFLOW: {
        create: async (_id: string, _params: unknown) => {
            console.warn('[Workflow] ROOM_JOIN_WORKFLOW is not implemented in self-hosted mode');
        },
    },
    PUSH_NOTIFICATION_WORKFLOW: {
        create: async (_id: string, _params: unknown) => {
            console.warn('[Workflow] PUSH_NOTIFICATION_WORKFLOW is not implemented in self-hosted mode');
        },
    },
};

// ── DO namespaces (must come after env is built) ──────────────────────────────

env.ROOMS = createDONamespace(client, 'ROOMS', RoomDurableObject, env);
env.SYNC = createDONamespace(client, 'SYNC', SyncDurableObject, env);
env.FEDERATION = createDONamespace(client, 'FEDERATION', FederationDurableObject, env);
env.ADMIN = createDONamespace(client, 'ADMIN', AdminDurableObject, env);
env.USER_KEYS = createDONamespace(client, 'USER_KEYS', UserKeysDurableObject, env);
env.PUSH = createDONamespace(client, 'PUSH', PushDurableObject, env);
env.RATE_LIMIT = createDONamespace(client, 'RATE_LIMIT', RateLimitDurableObject, env);
env.CALL_ROOMS = createDONamespace(client, 'CALL_ROOMS', CallRoomDurableObject, env);

// ── Start HTTP server ─────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '8787', 10);

// @ts-ignore — Bun global
Bun.serve({ port, fetch: (req: Request) => app.fetch(req, env) });

console.log(`[matrix-workers] Self-hosted server listening on http://0.0.0.0:${port}`);
console.log(`[matrix-workers] SERVER_NAME  = ${env.SERVER_NAME}`);
console.log(`[matrix-workers] libSQL URL   = ${LIBSQL_URL}`);
console.log(`[matrix-workers] Run migrations if this is first start:`);
console.log(`[matrix-workers]   npm run db:migrate:libsql`);
