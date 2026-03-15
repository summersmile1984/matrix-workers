/**
 * Seed script for the Matrix Workers homeserver (self-hosted / libSQL mode).
 *
 * Idempotently ensures the following data exists after a fresh migration:
 *   1. Admin user  (@admin:hs.localhost) with admin=1 and password "admin123"
 *   2. IDP Provider row (matrix-idp) — satisfies FK for idp_user_links
 *   3. AppService registration (agent-bridge) — connects the Bridge to the HS
 *
 * Usage:
 *   LIBSQL_URL=http://127.0.0.1:8080 bun run scripts/seed.ts
 *   npm run db:seed
 *
 * Environment variables (with defaults):
 *   LIBSQL_URL       — libSQL server URL           (default: http://localhost:8080)
 *   LIBSQL_TOKEN     — libSQL auth token            (default: empty)
 *   SERVER_NAME      — Matrix server name           (default: hs.localhost)
 *   IDP_ISSUER       — IDP issuer URL               (default: https://idp.localhost)
 *   HS_IDP_CLIENT_ID — IDP client ID for the HS     (default: from .env.local)
 *   AS_TOKEN         — AppService token              (default: hardcoded dev token)
 *   HS_TOKEN         — HomeServer token              (default: hardcoded dev token)
 *   BRIDGE_URL       — Bridge external URL           (default: https://bridge.localhost)
 *   ADMIN_PASSWORD   — Admin password                (default: admin123)
 */

import { createClient } from '@libsql/client/http';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Config ─────────────────────────────────────────────────────────────────────
const url = process.env.LIBSQL_URL || 'http://localhost:8080';
const authToken = process.env.LIBSQL_TOKEN;
const client = createClient({ url, authToken });

const SERVER_NAME = process.env.SERVER_NAME || 'hs.localhost';
const IDP_ISSUER = process.env.IDP_ISSUER || 'https://idp.localhost';
const HS_IDP_CLIENT_ID = process.env.HS_IDP_CLIENT_ID || 'a375f5539f85a1e69eb623ec2135ed44';
const AS_TOKEN = process.env.AS_TOKEN || '74a264c95f0d40b9a097d11c0489d3e15ef410b639cd49bfae81fda06748c3a8';
const HS_TOKEN = process.env.HS_TOKEN || '741a94d24c8e4482acfa93ed6dba65469f3aeab51c2940b494b285a24ed84c36';
const BRIDGE_URL = process.env.BRIDGE_URL || 'https://bridge.localhost';
const BRIDGE_SENDER = process.env.BRIDGE_SENDER || 'bridge-bot';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const log = (...args: unknown[]) => console.log('[seed]', ...args);

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Simple password hashing using Web Crypto (PBKDF2).
 * Matches the hashPassword() in src/utils/crypto.ts
 */
async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, 256
    );
    const hashBytes = new Uint8Array(hash);
    const saltHex = Array.from(salt, b => b.toString(16).padStart(2, '0')).join('');
    const hashHex = Array.from(hashBytes, b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2:100000:${saltHex}:${hashHex}`;
}

// ── 1. Admin user ──────────────────────────────────────────────────────────────

async function seedAdminUser() {
    const userId = `@admin:${SERVER_NAME}`;
    const existing = await client.execute({
        sql: 'SELECT user_id, admin, password_hash FROM users WHERE user_id = ?',
        args: [userId],
    });

    if (existing.rows.length === 0) {
        // Create admin user with password
        const passwordHash = await hashPassword(ADMIN_PASSWORD);
        await client.execute({
            sql: `INSERT INTO users (user_id, localpart, password_hash, is_guest, admin, created_at, updated_at)
                  VALUES (?, 'admin', ?, 0, 1, ?, ?)`,
            args: [userId, passwordHash, Date.now(), Date.now()],
        });
        log(`✅ Created admin user ${userId} (password: ${ADMIN_PASSWORD})`);
    } else {
        const row = existing.rows[0];
        const updates: string[] = [];

        // Ensure admin=1
        if (row.admin !== 1) {
            updates.push('admin = 1');
        }

        // Ensure password is set
        if (!row.password_hash) {
            const passwordHash = await hashPassword(ADMIN_PASSWORD);
            updates.push(`password_hash = '${passwordHash}'`);
        }

        if (updates.length > 0) {
            await client.execute({
                sql: `UPDATE users SET ${updates.join(', ')}, updated_at = ? WHERE user_id = ?`,
                args: [Date.now(), userId],
            });
            log(`✅ Updated admin user ${userId}: ${updates.map(u => u.split(' ')[0]).join(', ')}`);
        } else {
            log(`✓ Admin user ${userId} already configured`);
        }
    }
}

// ── 2. IDP Provider (matrix-idp) ───────────────────────────────────────────────

async function seedIdpProvider() {
    const existing = await client.execute({
        sql: `SELECT id FROM idp_providers WHERE id = 'matrix-idp'`,
        args: [],
    });

    if (existing.rows.length === 0) {
        await client.execute({
            sql: `INSERT INTO idp_providers
                    (id, name, issuer_url, client_id, client_secret_encrypted, scopes, enabled, auto_create_users, username_claim, display_order)
                  VALUES (?, 'TuringFlow', ?, ?, '', 'openid profile email', 1, 1, 'email', 0)`,
            args: ['matrix-idp', IDP_ISSUER, HS_IDP_CLIENT_ID],
        });
        log(`✅ Created IDP provider 'matrix-idp' (issuer: ${IDP_ISSUER})`);
    } else {
        // Update issuer/client_id in case config changed
        await client.execute({
            sql: `UPDATE idp_providers SET issuer_url = ?, client_id = ? WHERE id = 'matrix-idp'`,
            args: [IDP_ISSUER, HS_IDP_CLIENT_ID],
        });
        log(`✓ IDP provider 'matrix-idp' already exists (updated issuer/client_id)`);
    }
}

// ── 3. AppService registration (agent-bridge) ─────────────────────────────────

async function seedAppService() {
    const existing = await client.execute({
        sql: `SELECT id FROM appservice_registrations WHERE id = 'agent-bridge'`,
        args: [],
    });

    // Build namespace JSON:
    //   1. bridge-bot sender — exact match
    //   2. Broad catch-all for any agent virtual user under this domain
    //      The bridge will refine namespaces dynamically via syncNamespaces(),
    //      but the seed needs to be broad enough for initial AS event routing.
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedSender = escapeRegex(BRIDGE_SENDER);
    const escapedDomain = escapeRegex(SERVER_NAME);
    const namespaces = JSON.stringify({
        users: [
            { exclusive: true, regex: `@${escapedSender}:${escapedDomain}` },
            { exclusive: true, regex: `@agent_.*:${escapedDomain}` },
        ],
        rooms: [],
        aliases: [],
    });

    if (existing.rows.length === 0) {
        await client.execute({
            sql: `INSERT INTO appservice_registrations
                    (id, url, as_token, hs_token, sender_localpart, rate_limited, protocols, namespaces, created_at)
                  VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
            args: ['agent-bridge', BRIDGE_URL, AS_TOKEN, HS_TOKEN, BRIDGE_SENDER, namespaces, Date.now()],
        });
        log(`✅ Registered AppService 'agent-bridge' (url: ${BRIDGE_URL})`);
    } else {
        // Update URL and tokens in case config changed
        await client.execute({
            sql: `UPDATE appservice_registrations SET url = ?, as_token = ?, hs_token = ?, namespaces = ? WHERE id = 'agent-bridge'`,
            args: [BRIDGE_URL, AS_TOKEN, HS_TOKEN, namespaces],
        });
        log(`✓ AppService 'agent-bridge' already exists (updated url/tokens)`);
    }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    log(`Seeding homeserver database...`);
    log(`  Server:  ${SERVER_NAME}`);
    log(`  LibSQL:  ${url}`);
    log(`  IDP:     ${IDP_ISSUER}`);
    log('');

    await seedAdminUser();
    await seedIdpProvider();
    await seedAppService();

    log('');
    log('🎉 Seed complete — homeserver is ready.');
}

main().catch((err) => {
    console.error('[seed] ❌ Seed failed:', err);
    process.exit(1);
});
