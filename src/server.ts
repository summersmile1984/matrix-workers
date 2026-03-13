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
//   MEDIA_BACKEND        - Media storage backend: "fs" (default) or "s3"
//   MEDIA_PATH           - Filesystem media path (default: ./data/media)
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
import type { MediaStorage } from './adapters/media-storage';
import { FileSystemMediaStorage } from './adapters/fs-media-storage';
// import { S3MediaStorage } from './adapters/s3-media-storage';
import { createMastraInstance } from './mastra';
import { createMastraWorkflowBinding } from './adapters/mastra-workflow-adapter';

import { RoomDurableObject } from './durable-objects/RoomDurableObject';
import { SyncDurableObject } from './durable-objects/SyncDurableObject';
import { FederationDurableObject } from './durable-objects/FederationDurableObject';
import { AdminDurableObject } from './durable-objects/AdminDurableObject';
import { UserKeysDurableObject } from './durable-objects/UserKeysDurableObject';
import { PushDurableObject } from './durable-objects/PushDurableObject';
import { RateLimitDurableObject } from './durable-objects/RateLimitDurableObject';
import { CallRoomDurableObject } from './durable-objects/call-room';

import { ResendEmailAdapter } from './adapters/email-adapter';
import { LLMAdapter } from './adapters/ai-adapter';

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

// ── Media storage backend ─────────────────────────────────────────────────────

function createMediaStorage(): MediaStorage {
    const backend = process.env.MEDIA_BACKEND || 'fs';
    switch (backend) {
        case 'fs':
            return new FileSystemMediaStorage(process.env.MEDIA_PATH || './data/media');
        // case 's3':
        //     return new S3MediaStorage({
        //         endpoint: process.env.S3_ENDPOINT!,
        //         bucket: process.env.S3_BUCKET!,
        //         accessKey: process.env.S3_ACCESS_KEY!,
        //         secretKey: process.env.S3_SECRET_KEY!,
        //         region: process.env.S3_REGION,
        //         forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        //     });
        default:
            throw new Error(`[server] Unknown MEDIA_BACKEND: ${backend}. Supported: fs, s3`);
    }
}

// ── Mastra workflow engine ────────────────────────────────────────────────────

const mastra = createMastraInstance(LIBSQL_URL, LIBSQL_TOKEN);

// ── Build env object ──────────────────────────────────────────────────────────
// This object mirrors the Cloudflare Workers env injected by wrangler.jsonc.
// DO namespaces and workflow bindings are added last because they need a
// reference to the full env object.

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

    // ── Media storage (R2 in CF, filesystem/S3 in self-hosted) ────────────────
    MEDIA: createMediaStorage(),

    // ── Environment variables (mirrors wrangler.jsonc vars + secrets) ─────────
    SERVER_NAME: process.env.SERVER_NAME,
    SERVER_VERSION: process.env.SERVER_VERSION || '0.1.0',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    COTURN_SECRET: process.env.COTURN_SECRET,
    TURN_KEY_ID: process.env.TURN_KEY_ID,
    TURN_API_TOKEN: process.env.TURN_API_TOKEN,
    OIDC_ENCRYPTION_KEY: process.env.OIDC_ENCRYPTION_KEY,
    IDP_ISSUER_URL: process.env.IDP_ISSUER_URL,
    IDP_CLIENT_ID: process.env.IDP_CLIENT_ID,
    ENABLE_TEST_REGISTRATION: process.env.ENABLE_TEST_REGISTRATION,
    APNS_KEY_ID: process.env.APNS_KEY_ID,
    APNS_TEAM_ID: process.env.APNS_TEAM_ID,
    APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
    APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT,
    EMAIL_FROM: process.env.EMAIL_FROM,
    ADMIN_CONTACT_EMAIL: process.env.ADMIN_CONTACT_EMAIL,
    ADMIN_CONTACT_MXID: process.env.ADMIN_CONTACT_MXID,
    SUPPORT_PAGE_URL: process.env.SUPPORT_PAGE_URL,
    SIGNING_KEY: process.env.SIGNING_KEY,
    ALLOW_E2EE: process.env.ALLOW_E2EE,
    MAX_UPLOAD_SIZE_MB: process.env.MAX_UPLOAD_SIZE_MB,

    // ── CF-specific bindings that have no self-hosted equivalent ─────────────
    LIVEKIT_API: process.env.LIVEKIT_URL ? {
        fetch: async (req: Request | string, init?: RequestInit) => {
            const baseUrl = process.env.LIVEKIT_URL!.replace('ws://', 'http://').replace('wss://', 'https://');
            const url = new URL(typeof req === 'string' ? req : req.url);

            // Rewrite Cloudflare VPC request to local Docker URL
            const targetUrl = new URL(url.pathname + url.search, baseUrl);

            const reqInit = typeof req === 'string' ? init : {
                method: req.method,
                headers: req.headers,
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.clone().arrayBuffer()
            };

            return fetch(targetUrl.toString(), reqInit);
        }
    } : null,
    ANALYTICS: null,   // CF Analytics Engine — not available
    AI: process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? new LLMAdapter(process.env.LLM_API_KEY, process.env.LLM_BASE_URL) : null,   // Unified LLM adapter
    EMAIL: process.env.RESEND_API_KEY ? new ResendEmailAdapter(process.env.RESEND_API_KEY) : null,   // Replaced with Resend HTTP API adapter
    BROWSER: null,   // Browser Rendering — not available
};

// ── DO namespaces (must come after env is built) ──────────────────────────────

env.ROOMS = createDONamespace(client, 'ROOMS', RoomDurableObject, env);
env.SYNC = createDONamespace(client, 'SYNC', SyncDurableObject, env);
env.FEDERATION = createDONamespace(client, 'FEDERATION', FederationDurableObject, env);
env.ADMIN = createDONamespace(client, 'ADMIN', AdminDurableObject, env);
env.USER_KEYS = createDONamespace(client, 'USER_KEYS', UserKeysDurableObject, env);
env.PUSH = createDONamespace(client, 'PUSH', PushDurableObject, env);
// @ts-ignore - Constructor signature mismatch
env.RATE_LIMIT = createDONamespace(client, 'RATE_LIMIT', RateLimitDurableObject as any, env);
// @ts-ignore - Constructor signature mismatch 
env.CALL_ROOMS = createDONamespace(client, 'CALL_ROOMS', CallRoomDurableObject as any, env);

// ── Workflow bindings (must come after DO namespaces — workflows use env.SYNC) ─

env.ROOM_JOIN_WORKFLOW = createMastraWorkflowBinding(mastra, 'roomJoinWorkflow', env);
env.PUSH_NOTIFICATION_WORKFLOW = createMastraWorkflowBinding(mastra, 'pushNotificationWorkflow', env);
env.FEDERATION_CATCHUP_WORKFLOW = createMastraWorkflowBinding(mastra, 'federationCatchupWorkflow', env);
env.MEDIA_CLEANUP_WORKFLOW = createMastraWorkflowBinding(mastra, 'mediaCleanupWorkflow', env);
env.STATE_COMPACTION_WORKFLOW = createMastraWorkflowBinding(mastra, 'stateCompactionWorkflow', env);

// ── Start HTTP server ─────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '8787', 10);

// @ts-ignore — Bun global
Bun.serve({ port, idleTimeout: 60, fetch: (req: Request) => app.fetch(req, env) });

console.log(`[matrix-workers] Self-hosted server listening on http://0.0.0.0:${port}`);
console.log(`[matrix-workers] SERVER_NAME  = ${env.SERVER_NAME}`);
console.log(`[matrix-workers] libSQL URL   = ${LIBSQL_URL}`);
console.log(`[matrix-workers] Workflow engine: Mastra`);
console.log(`[matrix-workers] Run migrations if this is first start:`);
console.log(`[matrix-workers]   npm run db:migrate:libsql`);

