// Matrix Homeserver on Cloudflare Workers
// Main entry point

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types';

// Import API routes
import versions from './api/versions';
import login from './api/login';
import rooms from './api/rooms';
import sync from './api/sync';
import slidingSync from './api/sliding-sync';
import profile from './api/profile';
import media from './api/media';
import voip from './api/voip';
import keys from './api/keys';
import federation from './api/federation';
import admin from './api/admin';
import keyBackups from './api/key-backups';
import toDevice from './api/to-device';
import push from './api/push';
import accountData from './api/account-data';
import typing from './api/typing';
import receipts from './api/receipts';
import tags from './api/tags';
import devices from './api/devices';
import presence from './api/presence';
import aliases from './api/aliases';
import relations from './api/relations';
import spaces from './api/spaces';
import account from './api/account';
import search from './api/search';
import serverNotices from './api/server-notices';
import report from './api/report';
import calls from './api/calls';
import rtc from './api/rtc';
import appservice from './api/appservice';
import identity from './api/identity';
// import qrLogin from './api/qr-login'; // QR feature commented out - requires MSC4108/OIDC for Element X
import oidcAuth from './api/oidc-auth';
import oauth from './api/oauth';
import { adminDashboardHtml } from './admin/dashboard';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { requireAuth } from './middleware/auth';
import { analyticsMiddleware } from './middleware/analytics';

// Import Durable Objects
export { RoomDurableObject, SyncDurableObject, FederationDurableObject, CallRoomDurableObject, AdminDurableObject, UserKeysDurableObject, PushDurableObject, RateLimitDurableObject } from './durable-objects';

// Import Workflows
export { RoomJoinWorkflow, PushNotificationWorkflow, FederationCatchupWorkflow, MediaCleanupWorkflow, StateCompactionWorkflow } from './workflows';

// Create the main app
const app = new Hono<AppEnv>();

// CORS for Matrix clients - MUST BE FIRST to ensure headers are always sent
// (even on error responses from rate limiter or other middleware)
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Matrix-Origin'],
  exposeHeaders: ['Content-Type', 'Content-Length'],
  maxAge: 86400,
}));

// Global middleware
app.use('*', logger());
app.use('*', analyticsMiddleware());

// Rate limiting for Matrix API endpoints
app.use('/_matrix/*', rateLimitMiddleware);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', server: 'matrix-worker' }));

// Admin dashboard - serve HTML with security headers
app.get('/admin', (c) => {
  const html = adminDashboardHtml(c.env.SERVER_NAME);
  return c.html(html, 200, {
    // Content-Security-Policy for XSS protection
    // 'unsafe-inline' is needed for the inline scripts/styles in the dashboard
    // This could be improved by moving scripts to external files with nonces
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
});

app.get('/admin/', (c) => {
  const html = adminDashboardHtml(c.env.SERVER_NAME);
  return c.html(html, 200, {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
});

// Admin API routes
app.route('/', admin);

// ── Synapse Admin SPA ────────────────────────────────────────────────────────
// Serve the pre-built Synapse Admin UI at /synapse-admin/
// In Cloudflare Workers mode: files are served via Workers Static Assets
// In self-hosted (Bun) mode: files are served from the filesystem

const SYNAPSE_ADMIN_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return SYNAPSE_ADMIN_MIME[ext] || 'application/octet-stream';
}

async function serveSynapseAdminFile(c: any, filePath: string): Promise<Response | null> {
  // Default to index.html for the root or SPA routes (no file extension)
  if (!filePath || !filePath.includes('.')) {
    filePath = 'index.html';
  }

  // Try to serve from filesystem (self-hosted / Bun mode)
  try {
    if ('Bun' in globalThis) {
      // Use process.cwd() for reliable path resolution
      const fsPath = `${process.cwd()}/public/synapse-admin/${filePath}`;
      const file = (globalThis as any).Bun.file(fsPath);
      if (await file.exists()) {
        return new Response(file.stream(), {
          headers: {
            'Content-Type': getMimeType(filePath),
            'Cache-Control': filePath === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          },
        });
      }
    }
  } catch {
    // Not running in Bun — fall through
  }

  // Cloudflare Workers Static Assets mode
  if ((c.env as any).ASSETS) {
    try {
      const assetUrl = new URL(`/synapse-admin/${filePath}`, c.req.url);
      const response = await (c.env as any).ASSETS.fetch(new Request(assetUrl));
      if (response.ok) {
        return new Response(response.body, {
          headers: {
            'Content-Type': getMimeType(filePath),
            'Cache-Control': filePath === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
          },
        });
      }
    } catch {
      // Asset not found
    }
  }

  return null;
}

// Redirect /synapse-admin to /synapse-admin/
app.get('/synapse-admin', (c) => c.redirect('/synapse-admin/', 301));

// Serve /synapse-admin/ (root)
app.get('/synapse-admin/', async (c) => {
  const response = await serveSynapseAdminFile(c, 'index.html');
  if (response) return response;
  return c.json({ error: 'Synapse Admin files not found. Check public/synapse-admin/ directory.' }, 404);
});

// Serve /synapse-admin/* (sub-paths: assets, images, config, etc.)
app.get('/synapse-admin/:path{.+}', async (c) => {
  const filePath = c.req.param('path');
  const response = await serveSynapseAdminFile(c, filePath);
  if (response) return response;

  // SPA fallback: serve index.html for routes without file extensions
  if (!filePath.includes('.')) {
    const indexResponse = await serveSynapseAdminFile(c, 'index.html');
    if (indexResponse) return indexResponse;
  }

  return c.json({ error: 'Not found' }, 404);
});

// QR code login landing page - commented out, requires MSC4108/OIDC for Element X
// app.route('/', qrLogin);

// OIDC/SSO authentication
app.route('/', oidcAuth);

// OAuth 2.0 provider endpoints
app.route('/', oauth);

// Matrix version discovery
app.route('/', versions);

// Client-Server API
app.route('/', login);
app.route('/', rooms);
app.route('/', sync);
app.route('/', slidingSync);
app.route('/', profile);
app.route('/', media);
app.route('/', voip);
app.route('/', keys);
app.route('/', keyBackups);
app.route('/', toDevice);
app.route('/', push);
app.route('/', accountData);
app.route('/', typing);
app.route('/', receipts);
app.route('/', tags);
app.route('/', devices);
app.route('/', presence);
app.route('/', aliases);
app.route('/', relations);
app.route('/', spaces);
app.route('/', account);
app.route('/', serverNotices);
app.route('/', report);

// Cloudflare Calls-based video calling API
app.route('/', calls);

// MatrixRTC (LiveKit) JWT service for Element X calls
app.route('/', rtc);

// Application Service API
app.route('/', appservice);

// Identity Service API
app.route('/', identity);

// Server-Server (Federation) API
app.route('/', federation);

// Capabilities endpoint
app.get('/_matrix/client/v3/capabilities', (c) => {
  return c.json({
    capabilities: {
      'm.change_password': {
        enabled: true,
      },
      'm.room_versions': {
        default: '10',
        available: {
          '1': 'stable',
          '2': 'stable',
          '3': 'stable',
          '4': 'stable',
          '5': 'stable',
          '6': 'stable',
          '7': 'stable',
          '8': 'stable',
          '9': 'stable',
          '10': 'stable',
          '11': 'stable',
          '12': 'stable',
        },
      },
      'm.set_displayname': {
        enabled: true,
      },
      'm.set_avatar_url': {
        enabled: true,
      },
      'm.3pid_changes': {
        enabled: true,
      },
    },
  });
});

// Push rules now handled by push.ts

// Filter endpoints - persist filters in KV for sync optimization
app.post('/_matrix/client/v3/user/:userId/filter', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const requestedUserId = c.req.param('userId');

  // Users can only create filters for themselves
  if (userId !== requestedUserId) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'Cannot create filters for other users' }, 403);
  }

  let filter: Record<string, unknown>;
  try {
    filter = await c.req.json();
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON' }, 400);
  }

  // Generate filter ID and store in KV
  const filterId = crypto.randomUUID().split('-')[0];
  await c.env.CACHE.put(
    `filter:${userId}:${filterId}`,
    JSON.stringify(filter),
    { expirationTtl: 30 * 24 * 60 * 60 } // 30 days TTL
  );

  return c.json({ filter_id: filterId });
});

app.get('/_matrix/client/v3/user/:userId/filter/:filterId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const requestedUserId = c.req.param('userId');
  const filterId = c.req.param('filterId');

  // Users can only read their own filters
  if (userId !== requestedUserId) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'Cannot read filters for other users' }, 403);
  }

  const filterJson = await c.env.CACHE.get(`filter:${userId}:${filterId}`);
  if (!filterJson) {
    // Return empty filter if not found (per spec, unknown filter IDs should return empty)
    return c.json({});
  }

  try {
    const filter = JSON.parse(filterJson);
    return c.json(filter);
  } catch {
    return c.json({});
  }
});

// Account data endpoints now handled by account-data.ts

// Presence endpoints now handled by presence.ts

// Search endpoint - now handled by search.ts
app.route('/', search);

// Typing notifications now handled by typing.ts

// Read receipts now handled by receipts.ts

// Device management now handled by devices.ts

// Public rooms directory
app.get('/_matrix/client/v3/publicRooms', async (c) => {
  const db = c.env.DB;

  const rooms = await db.prepare(
    `SELECT r.room_id, r.room_version
     FROM rooms r
     WHERE r.is_public = 1
     LIMIT 100`
  ).all<{ room_id: string; room_version: string }>();

  const publicRooms: any[] = [];

  for (const room of rooms.results) {
    // Get room name and topic from state
    const nameEvent = await db.prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'`
    ).bind(room.room_id).first<{ content: string }>();

    const topicEvent = await db.prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'`
    ).bind(room.room_id).first<{ content: string }>();

    // Get member count
    const memberCount = await db.prepare(
      `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`
    ).bind(room.room_id).first<{ count: number }>();

    publicRooms.push({
      room_id: room.room_id,
      name: nameEvent ? JSON.parse(nameEvent.content).name : undefined,
      topic: topicEvent ? JSON.parse(topicEvent.content).topic : undefined,
      num_joined_members: memberCount?.count || 0,
      world_readable: false,
      guest_can_join: false,
    });
  }

  return c.json({
    chunk: publicRooms,
    total_room_count_estimate: publicRooms.length,
  });
});

app.post('/_matrix/client/v3/publicRooms', async (c) => {
  // Same as GET but with search/filter support
  return c.json({
    chunk: [],
    total_room_count_estimate: 0,
  });
});

// User directory search (requires authentication per Matrix spec)
app.post('/_matrix/client/v3/user_directory/search', requireAuth(), async (c) => {
  const db = c.env.DB;
  const requestingUserId = c.get('userId');

  let body: { search_term: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON' }, 400);
  }

  const searchTerm = body.search_term || '';
  const limit = Math.min(body.limit || 10, 50);

  console.log('[user_directory] Search request:', {
    requestingUserId,
    searchTerm,
    limit,
    userAgent: c.req.header('User-Agent'),
  });

  if (!searchTerm) {
    return c.json({ results: [], limited: false });
  }

  // Search for users using FTS5 for ranked full-text search
  // Escape ALL FTS5 special characters: @ is a column filter prefix, others are operators
  const ftsSearchTerm = searchTerm.replace(/[@'"*(){}\[\]:^~!\-+|&<>]/g, ' ').trim();

  let results: { results: { user_id: string; display_name: string | null; avatar_url: string | null }[] };

  if (ftsSearchTerm.length > 0) {
    // Try FTS5 first for ranked results
    try {
      // Wrap each token in double quotes to treat as literal
      const quotedTerms = ftsSearchTerm.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
      results = await db.prepare(`
        SELECT u.user_id, u.display_name, u.avatar_url
        FROM users_fts fts
        JOIN users u ON fts.user_id = u.user_id
        WHERE users_fts MATCH ?
          AND u.is_deactivated = 0
          AND u.is_guest = 0
          AND u.user_id != ?
        ORDER BY bm25(users_fts)
        LIMIT ?
      `).bind(quotedTerms, requestingUserId, limit + 1).all();
    } catch (ftsError) {
      console.warn('[user_directory] FTS5 search failed, falling back to LIKE:', ftsError);
      // Fallback to LIKE query
      const likePattern = `%${searchTerm}%`;
      results = await db.prepare(`
        SELECT user_id, display_name, avatar_url
        FROM users
        WHERE (user_id LIKE ? OR display_name LIKE ?)
          AND is_deactivated = 0
          AND is_guest = 0
          AND user_id != ?
        LIMIT ?
      `).bind(likePattern, likePattern, requestingUserId, limit + 1).all();
    }
  } else {
    // Original search term was all special chars (e.g. just "@"), use LIKE
    const likePattern = `%${searchTerm}%`;
    results = await db.prepare(`
      SELECT user_id, display_name, avatar_url
      FROM users
      WHERE (user_id LIKE ? OR display_name LIKE ?)
        AND is_deactivated = 0
        AND is_guest = 0
        AND user_id != ?
      LIMIT ?
    `).bind(likePattern, likePattern, requestingUserId, limit + 1).all();
  }

  const limited = results.results.length > limit;
  // Return explicit null values (not undefined/omitted) so Element X knows user exists
  const users = results.results.slice(0, limit).map(u => ({
    user_id: u.user_id,
    display_name: u.display_name || null,
    avatar_url: u.avatar_url || null,
  }));

  console.log('[user_directory] Search results:', {
    searchTerm,
    resultCount: users.length,
    limited,
    firstResult: users[0],
  });

  return c.json({ results: users, limited });
});

// Third-party protocols (stub - no bridges configured)
app.get('/_matrix/client/v3/thirdparty/protocols', async (c) => {
  return c.json({});
});

// Dehydrated device (MSC3814 - stub)
app.get('/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device', async (c) => {
  return c.json({
    errcode: 'M_NOT_FOUND',
    error: 'No dehydrated device found',
  }, 404);
});

// OIDC auth metadata endpoints are now handled by oidc-auth.ts
// Legacy unstable endpoint for backwards compatibility
app.get('/_matrix/client/unstable/org.matrix.msc2965/auth_issuer', async (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect('/_matrix/client/v1/auth_metadata', 307);
});

app.get('/_matrix/client/unstable/org.matrix.msc2965/auth_metadata', async (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect('/_matrix/client/v1/auth_metadata', 307);
});

// Fallback for unknown endpoints
app.all('/_matrix/*', (c) => {
  return c.json({
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  }, 404);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({
    errcode: 'M_UNKNOWN',
    error: 'An internal error occurred',
  }, 500);
});

export default app;
