// Authentication middleware

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { hashToken } from '../utils/crypto';
import { getUserByTokenHash } from '../services/database';
import { getAppServiceByToken } from '../services/appservice';

export type AuthContext = {
  userId: string;
  deviceId: string | null;
  accessToken: string;
  /** API scopes granted to this auth context */
  scopes: string[];
};

// Extract access token from request
export function extractAccessToken(request: Request): string | null {
  // Check Authorization header first
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  // Fall back to query parameter
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('access_token');
  if (queryToken) {
    return queryToken;
  }

  return null;
}

// In-memory cache for IDP-validated tokens (avoids introspection on every request)
// Maps: raw token → { authContext, expiresAt }
const idpTokenCache = new Map<string, { auth: AuthContext; expiresAt: number }>();
const IDP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Helper: resolve an IDP user from claims (JWT or userinfo) to a Matrix AuthContext
async function resolveIdpUser(env: any, claims: Record<string, any>, token: string): Promise<AuthContext> {
  const serverName = env.SERVER_NAME;
  const sub = claims.sub;
  let userId: string;

  // 1. Check idp_user_links for existing sub → user_id mapping
  const existingLink = await env.DB.prepare(
    'SELECT user_id FROM idp_user_links WHERE external_id = ?'
  ).bind(sub).first();

  if (existingLink) {
    userId = existingLink.user_id as string;
    console.log(`[AUTH] Found existing IDP link: sub=${sub} → ${userId}`);

    // Update last_login_at
    await env.DB.prepare(
      'UPDATE idp_user_links SET last_login_at = ? WHERE external_id = ?'
    ).bind(Date.now(), sub).run();
  } else {
    // 2. No link found — JIT create user
    let localpart = sub;
    if (claims.email) {
      localpart = claims.email.split('@')[0];
    }
    localpart = localpart.toLowerCase().replace(/[^a-z0-9._=-]/g, '_');
    userId = `@${localpart}:${serverName}`;

    // Create user in users table
    try {
      const existingUser = await env.DB.prepare(
        'SELECT user_id FROM users WHERE user_id = ?'
      ).bind(userId).first();

      if (!existingUser) {
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO users (user_id, localpart, password_hash, display_name, avatar_url, is_guest, is_deactivated, admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
        ).bind(userId, localpart, '', claims.name || claims.email || localpart, '', now, now).run();
        console.log(`[AUTH] JIT created local user ${userId} from IDP`);
      }
    } catch (err) {
      console.error('[AUTH] JIT create user error:', err);
    }

    // Create link in idp_user_links
    try {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO idp_user_links (provider_id, external_id, user_id, external_email, external_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('matrix-idp', sub, userId, claims.email || '', claims.name || '', now, now).run();
      console.log(`[AUTH] Created IDP link: sub=${sub} → ${userId}`);
    } catch (err) {
      console.error('[AUTH] Create IDP link error:', err);
    }
  }

  // 3. Ensure device exists for this token
  const tokenHashBytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  );
  const deviceId = 'OIDC_' + Array.from(tokenHashBytes.slice(0, 5))
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

  try {
    const existingDevice = await env.DB.prepare(
      'SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?'
    ).bind(userId, deviceId).first();

    if (!existingDevice) {
      await env.DB.prepare(
        `INSERT INTO devices (user_id, device_id, display_name, created_at) VALUES (?, ?, ?, ?)`
      ).bind(userId, deviceId, 'OIDC Login', Date.now()).run();
      console.log(`[AUTH] Auto-created device ${deviceId} for user ${userId}`);
    }
  } catch (err) {
    console.error('[AUTH] Auto-create device error:', err);
  }

  const authResult: AuthContext = {
    userId,
    deviceId,
    accessToken: token,
    scopes: ['matrix:full'],  // IDP users get full Matrix access
  };

  // Cache the result
  idpTokenCache.set(token, {
    auth: authResult,
    expiresAt: Date.now() + IDP_CACHE_TTL_MS,
  });

  return authResult;
}

// Validate access token and return user info
// Dual-mode: checks local DB first, then IDP-SERVER introspect if configured
export async function validateAccessToken(
  env: any,
  token: string
): Promise<AuthContext | null> {
  // 0. Check IDP token cache first
  const cached = idpTokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }
  if (cached) {
    idpTokenCache.delete(token); // expired
  }

  // 1. Try local DB first (existing tokens, password login, etc.)
  const tokenHash = await hashToken(token);
  const result = await getUserByTokenHash(env.DB, tokenHash);

  if (result) {
    return {
      userId: result.userId,
      deviceId: result.deviceId,
      accessToken: token,
      scopes: ['matrix:full'],  // Local token users get full access
    };
  }

  // 2. If IDP-SERVER is configured, try JWKS-based JWT verification (no client_secret needed)
  if (env.IDP_ISSUER && env.HS_IDP_CLIENT_ID) {
    // 2a. Try JWT JWKS verification first
    try {
      const { verifyIdpJwt } = await import('../services/idp-jwt');
      console.log(`[AUTH] Trying IDP JWKS verification for token`);
      const claims = await verifyIdpJwt(token, env.IDP_ISSUER);

      if (claims?.sub) {
        return await resolveIdpUser(env, claims, token);
      }
    } catch (err) {
      console.log('[AUTH] JWT verification failed, trying userinfo for opaque token...');
    }

    // 2b. Fallback: use IDP userinfo endpoint for opaque tokens
    try {
      const idpUrl = env.IDP_ISSUER.replace(/\/+$/, '');
      const userinfoResp = await fetch(`${idpUrl}/oauth2/userinfo`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (userinfoResp.ok) {
        const claims = await userinfoResp.json() as Record<string, any>;
        console.log(`[AUTH] IDP userinfo resolved user: sub=${claims.sub}, email=${claims.email}`);
        if (claims.sub) {
          return await resolveIdpUser(env, claims, token);
        }
      } else {
        console.log(`[AUTH] IDP userinfo returned ${userinfoResp.status}`);
      }
    } catch (err) {
      console.error('[AUTH] IDP userinfo error:', err);
    }
  } else {
    console.log(`[AUTH] IDP not configured. IDP_ISSUER=${env.IDP_ISSUER}, HS_IDP_CLIENT_ID=${env.HS_IDP_CLIENT_ID ? 'set' : 'unset'}`);
  }

  return null;
}

// Middleware that requires authentication
export function requireAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractAccessToken(c.req.raw);
    const path = new URL(c.req.url).pathname;

    if (!token) {
      const authHeader = c.req.raw.headers.get('Authorization');
      console.log(`[AUTH] Missing token for ${path}. Authorization header: ${authHeader || 'NONE'}`);
      return Errors.missingToken().toResponse();
    }

    const tokenPrefix = token.substring(0, 8);
    console.log(`[AUTH] Validating token ${tokenPrefix}... for ${path}`);

    let auth = await validateAccessToken(c.env, token);

    // If normal token validation fails, try app service token
    if (!auth) {
      try {
        const appservice = await getAppServiceByToken(c.env.DB, token);
        if (appservice) {
          const url = new URL(c.req.url);
          const asUserId = url.searchParams.get('user_id');
          const serverName = c.env.SERVER_NAME;
          const senderUserId = asUserId || `@${appservice.sender_localpart}:${serverName}`;
          auth = {
            userId: senderUserId,
            deviceId: null,
            accessToken: token,
            scopes: ['matrix:full'],  // AppService users get full access
          };
        }
      } catch (asErr) {
        // Ignore AS token lookup errors
      }
    }

    if (!auth) {
      console.log(`[AUTH] Token ${tokenPrefix}... is INVALID for ${path}. Token length: ${token.length}`);
      return Errors.unknownToken().toResponse();
    }

    console.log(`[AUTH] Token ${tokenPrefix}... valid for user ${auth.userId}`);

    c.set('auth', auth);
    c.set('userId', auth.userId);
    c.set('deviceId', auth.deviceId);
    c.set('accessToken', auth.accessToken);

    return next();
  });
}

// Middleware that allows optional authentication
export function optionalAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractAccessToken(c.req.raw);

    if (token) {
      const auth = await validateAccessToken(c.env, token);
      if (auth) {
        c.set('auth', auth);
        c.set('userId', auth.userId);
        c.set('deviceId', auth.deviceId);
        c.set('accessToken', auth.accessToken);
      }
    }

    return next();
  });
}
