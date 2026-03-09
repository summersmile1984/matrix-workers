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
    };
  }

  // 2. If IDP-SERVER is configured, try introspect
  if (env.IDP_ISSUER_URL && env.IDP_CLIENT_ID && env.IDP_CLIENT_SECRET) {
    try {
      const introspectUrl = `${env.IDP_ISSUER_URL}/api/auth/oauth2/introspect`;
      const credentials = btoa(`${env.IDP_CLIENT_ID}:${env.IDP_CLIENT_SECRET}`);
      console.log(`[AUTH] Trying IDP introspect at ${introspectUrl}`);
      const resp = await fetch(introspectUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: `token=${encodeURIComponent(token)}`,
      });

      const respText = await resp.text();
      console.log(`[AUTH] IDP introspect response: ${resp.status} ${respText.slice(0, 500)}`);

      let data: { active?: boolean; sub?: string; email?: string; scope?: string } | null = null;
      try { data = JSON.parse(respText); } catch { /* not JSON */ }

      if (data?.active && data?.sub) {
        // Derive Matrix user ID from IDP sub/email
        const serverName = env.SERVER_NAME;
        let localpart = data.sub;

        // If sub looks like an email, use the part before @
        if (data.email) {
          localpart = data.email.split('@')[0];
        }

        // Sanitize for Matrix user ID
        localpart = localpart.toLowerCase().replace(/[^a-z0-9._=-]/g, '_');
        const userId = `@${localpart}:${serverName}`;

        // Auto-create local user if not exists
        try {
          const existing = await env.DB.prepare(
            'SELECT user_id FROM users WHERE user_id = ?'
          ).bind(userId).first();

          if (!existing) {
            await env.DB.prepare(
              `INSERT INTO users (user_id, display_name, created_at) VALUES (?, ?, ?)`
            ).bind(userId, data.email || localpart, Date.now()).run();
            console.log(`[AUTH] Auto-created local user ${userId} from IDP`);
          }
        } catch (err) {
          // Ignore if user already exists (race condition)
          console.error('[AUTH] Auto-create user error (may be OK):', err);
        }

        // Auto-create device for OIDC tokens (Matrix SDK requires device_id)
        // Derive a stable device ID from the token to avoid duplicates
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
          console.error('[AUTH] Auto-create device error (may be OK):', err);
        }

        const authResult: AuthContext = {
          userId,
          deviceId,
          accessToken: token,
        };

        // Cache the result to avoid IDP introspection on every request
        idpTokenCache.set(token, {
          auth: authResult,
          expiresAt: Date.now() + IDP_CACHE_TTL_MS,
        });

        return authResult;
      }
    } catch (err) {
      console.error('[AUTH] IDP introspect error:', err);
    }
  } else {
    console.log(`[AUTH] IDP introspect not configured. IDP_ISSUER_URL=${env.IDP_ISSUER_URL}, IDP_CLIENT_ID=${env.IDP_CLIENT_ID ? 'set' : 'unset'}, IDP_CLIENT_SECRET=${env.IDP_CLIENT_SECRET ? 'set' : 'unset'}`);
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
