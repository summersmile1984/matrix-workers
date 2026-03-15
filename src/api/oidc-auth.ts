// OIDC Authentication API endpoints
// Handles OAuth flow for external Identity Providers

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  fetchOIDCDiscovery,
  fetchJWKS,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  validateIDToken,
  generateRandomString,
  generateCodeVerifier,
  generateCodeChallenge,
  deriveUsername,
} from '../services/oidc';
import { formatUserId } from '../utils/ids';
import { generateAccessToken, generateDeviceId } from '../utils/ids';
import { hashToken } from '../utils/crypto';
import { createUser, getUserById, createDevice, createAccessToken } from '../services/database';
import { requireAuth } from '../middleware/auth';
import { generateOpaqueId } from '../utils/ids';

const app = new Hono<AppEnv>();

// Build an IdPProvider from env vars (no DB involved)
function getEnvIdpProvider(env: any): IdPProvider | null {
  if (!env.IDP_ISSUER || !env.HS_IDP_CLIENT_ID) {
    return null;
  }
  return {
    id: 'matrix-idp',
    name: 'TuringFlow',
    issuer_url: env.IDP_ISSUER,
    client_id: env.HS_IDP_CLIENT_ID,
    client_secret_encrypted: '', // not used — secret comes from env
    scopes: 'openid profile email',
    enabled: 1,
    auto_create_users: 1,
    username_claim: 'email',
    display_order: 0,
    icon_url: null,
  };
}

interface IdPProvider {
  id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
}

interface IdPUserLink {
  id: number;
  provider_id: string;
  external_id: string;
  user_id: string;
  external_email: string | null;
  external_name: string | null;
}

interface OAuthState {
  providerId: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  codeVerifier?: string;
}

// Version byte for encrypted secrets
// 0x01 = legacy (SERVER_NAME-based key) - INSECURE, kept for migration
// 0x02 = secure (OIDC_ENCRYPTION_KEY)
const ENCRYPTION_VERSION_LEGACY = 0x01;
const ENCRYPTION_VERSION_SECURE = 0x02;

// Get the encryption key (prefer OIDC_ENCRYPTION_KEY, fall back to SERVER_NAME for legacy)
async function getEncryptionKey(
  env: { SERVER_NAME: string; OIDC_ENCRYPTION_KEY?: string },
  version: number
): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  if (version === ENCRYPTION_VERSION_SECURE && env.OIDC_ENCRYPTION_KEY) {
    // Use the secure key (base64-encoded 32 bytes)
    const keyBytes = Uint8Array.from(atob(env.OIDC_ENCRYPTION_KEY), (c) => c.charCodeAt(0));
    if (keyBytes.length !== 32) {
      throw new Error('OIDC_ENCRYPTION_KEY must be 32 bytes (base64 encoded)');
    }
    return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // Legacy key derivation (INSECURE - only for decrypting old secrets)
  console.warn('Using legacy OIDC encryption - please set OIDC_ENCRYPTION_KEY');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SERVER_NAME.padEnd(32, '0').slice(0, 32)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt a secret using AES-GCM
// Uses OIDC_ENCRYPTION_KEY if available, otherwise falls back to SERVER_NAME (legacy)
async function encryptSecret(
  secret: string,
  env: { SERVER_NAME: string; OIDC_ENCRYPTION_KEY?: string }
): Promise<string> {
  const encoder = new TextEncoder();

  // Determine which version to use
  const version = env.OIDC_ENCRYPTION_KEY ? ENCRYPTION_VERSION_SECURE : ENCRYPTION_VERSION_LEGACY;
  const keyMaterial = await getEncryptionKey(env, version);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, encoder.encode(secret));

  // Combine version byte, IV, and ciphertext
  const encryptedBytes = new Uint8Array(encrypted);
  const combined = new Uint8Array(1 + iv.length + encryptedBytes.length);
  combined[0] = version;
  combined.set(iv, 1);
  combined.set(encryptedBytes, 1 + iv.length);

  return btoa(String.fromCharCode(...combined));
}

// Decrypt a secret
// Automatically detects version and uses appropriate key
async function decryptSecret(
  encryptedSecret: string,
  env: { SERVER_NAME: string; OIDC_ENCRYPTION_KEY?: string }
): Promise<string> {
  const combined = Uint8Array.from(atob(encryptedSecret), (c) => c.charCodeAt(0));

  // Check if this is a versioned secret (starts with 0x01 or 0x02)
  let version: number;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;

  if (combined[0] === ENCRYPTION_VERSION_LEGACY || combined[0] === ENCRYPTION_VERSION_SECURE) {
    // New format with version byte
    version = combined[0];
    iv = combined.slice(1, 13);
    ciphertext = combined.slice(13);
  } else {
    // Old format without version byte (legacy)
    version = ENCRYPTION_VERSION_LEGACY;
    iv = combined.slice(0, 12);
    ciphertext = combined.slice(12);
  }

  const keyMaterial = await getEncryptionKey(env, version);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial, ciphertext);

  return new TextDecoder().decode(decrypted);
}

// GET /auth/oidc/providers - List enabled IdP providers (public)
app.get('/auth/oidc/providers', async (c) => {
  const db = c.env.DB;

  // Start with env-based IDP provider (if configured)
  const envIdp = getEnvIdpProvider(c.env);
  const providers: { id: string; name: string; icon_url: string | null; login_url: string }[] = [];

  if (envIdp) {
    providers.push({
      id: envIdp.id,
      name: envIdp.name,
      icon_url: envIdp.icon_url,
      login_url: `/auth/oidc/${envIdp.id}/login`,
    });
  }

  // Add DB-stored providers (excluding matrix-idp to avoid duplicates)
  const result = await db.prepare(`
    SELECT id, name, icon_url, display_order
    FROM idp_providers
    WHERE enabled = 1 AND id != 'matrix-idp'
    ORDER BY display_order ASC, name ASC
  `).all<{ id: string; name: string; icon_url: string | null; display_order: number }>();

  for (const p of result.results) {
    providers.push({
      id: p.id,
      name: p.name,
      icon_url: p.icon_url,
      login_url: `/auth/oidc/${p.id}/login`,
    });
  }

  return c.json({ providers });
});

// GET /auth/oidc/:providerId/login - Initiate OAuth flow
app.get('/auth/oidc/:providerId/login', async (c) => {
  const providerId = c.req.param('providerId');
  const returnTo = c.req.query('return_to') || '/';
  const db = c.env.DB;

  // Get provider config: env-based for matrix-idp, DB for others
  let provider: IdPProvider | null = null;
  if (providerId === 'matrix-idp') {
    provider = getEnvIdpProvider(c.env);
  } else {
    provider = await db.prepare(`
      SELECT * FROM idp_providers WHERE id = ? AND enabled = 1
    `).bind(providerId).first<IdPProvider>();
  }

  if (!provider) {
    return c.json({ errcode: 'M_NOT_FOUND', error: 'Identity provider not found' }, 404);
  }

  try {
    // Fetch OIDC discovery
    const discovery = await fetchOIDCDiscovery(provider.issuer_url);

    // Generate state and nonce
    const state = generateRandomString(32);
    const nonce = generateRandomString(32);

    // Generate PKCE code verifier and challenge (RFC 7636)
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Build redirect URI
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || c.env.SERVER_NAME;
    const protocol = c.req.header('x-forwarded-proto') || (c.req.url.startsWith('https') ? 'https' : 'http');
    const redirectUri = `${protocol}://${host}/auth/oidc/${providerId}/callback`;

    // Store state in KV (expires in 10 minutes)
    const stateData: OAuthState = {
      providerId,
      nonce,
      redirectUri,
      returnTo,
      codeVerifier,
    };
    await c.env.SESSIONS.put(`oidc_state:${state}`, JSON.stringify(stateData), {
      expirationTtl: 600,
    });

    // Build authorization URL and redirect
    const authUrl = buildAuthorizationUrl(
      discovery,
      provider.client_id,
      redirectUri,
      provider.scopes,
      state,
      nonce,
      codeChallenge,
      'S256'
    );

    return c.redirect(authUrl);
  } catch (err) {
    console.error('OIDC login error:', err);
    return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to initiate login' }, 500);
  }
});

// GET /auth/oidc/:providerId/callback - Handle OAuth callback
app.get('/auth/oidc/:providerId/callback', async (c) => {
  const providerId = c.req.param('providerId');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');
  const db = c.env.DB;

  // Handle error from IdP
  if (error) {
    return c.html(generateErrorPage('Authentication Failed', errorDescription || error));
  }

  if (!code || !state) {
    return c.html(generateErrorPage('Invalid Request', 'Missing code or state parameter'));
  }

  // Retrieve and validate state
  const stateDataJson = await c.env.SESSIONS.get(`oidc_state:${state}`);
  if (!stateDataJson) {
    return c.html(generateErrorPage('Invalid State', 'The login session has expired. Please try again.'));
  }

  const stateData: OAuthState = JSON.parse(stateDataJson);

  // Delete state (one-time use)
  await c.env.SESSIONS.delete(`oidc_state:${state}`);

  // Validate provider matches
  if (stateData.providerId !== providerId) {
    return c.html(generateErrorPage('Invalid State', 'Provider mismatch'));
  }

  // Get provider config: env-based for matrix-idp, DB for others
  let provider: IdPProvider | null = null;
  if (providerId === 'matrix-idp') {
    provider = getEnvIdpProvider(c.env);
  } else {
    provider = await db.prepare(`
      SELECT * FROM idp_providers WHERE id = ? AND enabled = 1
    `).bind(providerId).first<IdPProvider>();
  }

  if (!provider) {
    return c.html(generateErrorPage('Provider Not Found', 'Identity provider not found or disabled'));
  }

  try {
    // Fetch OIDC discovery and JWKS
    const discovery = await fetchOIDCDiscovery(provider.issuer_url);
    const jwks = await fetchJWKS(discovery.jwks_uri);

    // Get client secret: env var for matrix-idp, decrypt for DB providers
    let clientSecret: string | null = null;
    if (providerId === 'matrix-idp') {
      // matrix-idp is a public client using PKCE; no secret required
      clientSecret = c.env.IDP_CLIENT_SECRET || null;
    } else if (provider.client_secret_encrypted) {
      clientSecret = await decryptSecret(provider.client_secret_encrypted, c.env);
    }
    console.log(`[OIDC] Token exchange: client_id=${provider.client_id}, secret_status=${clientSecret ? 'confidential' : 'public'}`);

    // Exchange code for tokens (with PKCE code_verifier if present)
    // Build the resource indicator for RFC 8707 — tells IDP to issue JWT access_token
    // The resource should be the agent server URL so the JWT audience matches
    const resourceIndicator = `https://agent.${c.env.SERVER_NAME?.replace(/^hs\./, '') || 'localhost'}`;

    const tokens = await exchangeCodeForTokens(
      discovery,
      provider.client_id,
      clientSecret,
      code,
      stateData.redirectUri,
      stateData.codeVerifier,
      resourceIndicator,
    );
    console.log(`[OIDC] Token exchange complete, resource=${resourceIndicator}`);

    // Validate ID token and extract claims
    // Use discovery.issuer (the actual issuer from the discovery doc) for validation,
    // which may differ from provider.issuer_url (our configured discovery URL)
    const claims = await validateIDToken(
      tokens.id_token,
      discovery.issuer,
      provider.client_id,
      stateData.nonce,
      jwks
    );

    // Ensure the env-based IDP provider exists in idp_providers (for FK constraint)
    // When the provider comes from env vars (e.g. matrix-idp), it's not stored in the DB,
    // but idp_user_links.provider_id has a FOREIGN KEY to idp_providers(id).
    if (providerId === 'matrix-idp') {
      await db.prepare(`
        INSERT OR IGNORE INTO idp_providers (id, name, issuer_url, client_id, client_secret_encrypted, scopes, enabled, auto_create_users, username_claim, display_order)
        VALUES (?, ?, ?, ?, '', ?, 1, 1, ?, 0)
      `).bind(
        'matrix-idp',
        provider.name,
        provider.issuer_url,
        provider.client_id,
        provider.scopes,
        provider.username_claim
      ).run();
    }

    // Check if user link exists
    let userLink = await db.prepare(`
      SELECT * FROM idp_user_links WHERE provider_id = ? AND external_id = ?
    `).bind(providerId, claims.sub).first<IdPUserLink>();

    let userId: string;

    if (userLink) {
      // Existing user - update last login
      userId = userLink.user_id;
      await db.prepare(`
        UPDATE idp_user_links SET last_login_at = ?, external_email = ?, external_name = ?
        WHERE id = ?
      `).bind(Date.now(), claims.email || null, claims.name || null, userLink.id).run();
    } else {
      // New user
      if (!provider.auto_create_users) {
        return c.html(generateErrorPage(
          'Account Not Found',
          'No account is linked to this identity. Please contact your administrator.'
        ));
      }

      // Derive username from claims
      const username = deriveUsername(claims, provider.username_claim);
      userId = formatUserId(username, c.env.SERVER_NAME);

      // Check if Matrix user already exists
      const existingUser = await getUserById(db, userId);
      if (existingUser) {
        // User exists but not linked - check if we should auto-link or error
        // For now, auto-link if the user exists
        await db.prepare(`
          INSERT INTO idp_user_links (provider_id, external_id, user_id, external_email, external_name, last_login_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(providerId, claims.sub, userId, claims.email || null, claims.name || null, Date.now()).run();

        // Ensure admin rights for 'admin' (for e2e testing & bootstrapping) if they don't have it
        if (username === 'admin' && !existingUser.admin) {
          await db.prepare('UPDATE users SET admin = 1 WHERE user_id = ?').bind(userId).run();
          console.log(`[OIDC] Auto-granted admin rights to existing user ${userId}`);
        }
      } else {
        // Create new Matrix user
        await createUser(db, userId, username, null, false);

        // Auto-grant admin rights if the username is 'admin' (for e2e testing & bootstrapping)
        if (username === 'admin') {
          await db.prepare('UPDATE users SET admin = 1 WHERE user_id = ?').bind(userId).run();
          console.log(`[OIDC] Auto-granted admin rights to ${userId}`);
        }

        // Set display name if available
        if (claims.name) {
          await db.prepare(`
            UPDATE users SET display_name = ? WHERE user_id = ?
          `).bind(claims.name, userId).run();
        }

        // Create user link
        await db.prepare(`
          INSERT INTO idp_user_links (provider_id, external_id, user_id, external_email, external_name, last_login_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(providerId, claims.sub, userId, claims.email || null, claims.name || null, Date.now()).run();
      }
    }

    // Generate Matrix access token
    const deviceId = await generateDeviceId();
    await createDevice(db, userId, deviceId, `SSO Login (${provider.name})`);

    const accessToken = await generateAccessToken();
    const tokenHash = await hashToken(accessToken);
    const tokenId = await generateOpaqueId(16);
    await createAccessToken(db, tokenId, tokenHash, userId, deviceId);

    // Store IDP tokens in SESSIONS KV for on-behalf-of auth (bridge → agent server)
    // The bridge can later retrieve these via GET /admin/api/users/:userId/idp-token
    await c.env.SESSIONS.put(`idp_tokens:${userId}`, JSON.stringify({
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      provider_id: providerId,
      client_id: provider.client_id,
      issuer_url: provider.issuer_url,
      updated_at: Date.now(),
    }), {
      expirationTtl: 30 * 24 * 60 * 60, // 30 days
    });
    console.log(`[OIDC] IDP tokens stored for ${userId} (on-behalf-of auth)`);

    // If returnTo is set, redirect with appropriate token format
    if (stateData.returnTo) {
      const returnToUrl = stateData.returnTo;
      
      // Check if returnTo is a custom scheme (e.g. com.aotsea://login) — SSO login flow
      // In this case, generate a short-lived loginToken per Matrix spec
      if (!returnToUrl.startsWith('http://') && !returnToUrl.startsWith('https://') && !returnToUrl.startsWith('/')) {
        // SSO login redirect: generate a loginToken (short-lived, one-time use)
        const loginTokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const loginToken = btoa(String.fromCharCode(...loginTokenBytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
        
        const loginTokenHash = await hashToken(loginToken);
        await c.env.SESSIONS.put(
          `login_token:${loginTokenHash}`,
          JSON.stringify({
            user_id: userId,
            expires_at: Date.now() + 2 * 60 * 1000, // 2 minutes
          }),
          { expirationTtl: 120 }
        );
        
        // Redirect to client with loginToken as query parameter
        const separator = returnToUrl.includes('?') ? '&' : '?';
        console.log(`[SSO] Redirecting to client with loginToken: ${returnToUrl}`);
        return c.redirect(`${returnToUrl}${separator}loginToken=${encodeURIComponent(loginToken)}`);
      }
      
      // HTTP/relative returnTo (e.g. /admin) — redirect with token in URL fragment
      // The fragment is never sent to the server, keeping the token client-side only
      const fragment = `sso_token=${encodeURIComponent(accessToken)}&sso_user_id=${encodeURIComponent(userId)}&sso_device_id=${encodeURIComponent(deviceId)}`;
      return c.redirect(`${returnToUrl}#${fragment}`);
    }

    // Otherwise show the success page with credentials
    return c.html(generateSuccessPage(userId, accessToken, deviceId, c.env.SERVER_NAME));

  } catch (err) {
    console.error('OIDC callback error:', err);
    return c.html(generateErrorPage('Authentication Failed', String(err)));
  }
});

// Helper to generate error page HTML
function generateErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 400px; text-align: center; border: 1px solid #334155; }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    a { color: #0d9488; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">Return to login</a>
  </div>
</body>
</html>`;
}

// Helper to generate success page HTML
function generateSuccessPage(userId: string, accessToken: string, deviceId: string, serverName: string, returnTo?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 500px; text-align: center; border: 1px solid #334155; }
    h1 { color: #22c55e; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .info { background: #0f172a; padding: 16px; border-radius: 8px; text-align: left; margin-bottom: 24px; }
    .info label { font-size: 12px; color: #64748b; display: block; margin-bottom: 4px; }
    .info .value { font-family: monospace; font-size: 13px; word-break: break-all; margin-bottom: 12px; }
    .btn { display: inline-block; background: #0d9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 8px; }
    .btn:hover { background: #0f766e; }
    .btn-secondary { background: #334155; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Login Successful!</h1>
    <p>You are now logged in as:</p>
    <div class="info">
      <label>User ID</label>
      <div class="value">${userId}</div>
      <label>Homeserver</label>
      <div class="value">https://${serverName}</div>
      <label>Access Token</label>
      <div class="value">${accessToken}</div>
      <label>Device ID</label>
      <div class="value">${deviceId}</div>
    </div>
    <p style="font-size: 13px; color: #64748b;">Copy these credentials to configure your Matrix client.</p>
    <button class="btn" onclick="copyCredentials()">Copy Credentials</button>
    <a href="${returnTo || '/'}" class="btn btn-secondary">Continue</a>
  </div>
  <script>
    function copyCredentials() {
      const text = \`Homeserver: https://${serverName}
User ID: ${userId}
Access Token: ${accessToken}
Device ID: ${deviceId}\`;
      navigator.clipboard.writeText(text).then(() => {
        alert('Credentials copied to clipboard!');
      });
    }
  </script>
</body>
</html>`;
}

// GET /_matrix/client/v3/login/sso/redirect - SSO Login Redirect
// Per Matrix spec: redirects the user to the SSO provider for login.
// The client passes a `redirectUrl` where the user should be sent after login.
// We redirect to our OIDC flow which will eventually redirect back with a loginToken.
app.get('/_matrix/client/v3/login/sso/redirect', async (c) => {
  const redirectUrl = c.req.query('redirectUrl');
  if (!redirectUrl) {
    return c.json({ errcode: 'M_MISSING_PARAM', error: 'Missing redirectUrl parameter' }, 400);
  }

  // Check if IDP is configured
  const provider = getEnvIdpProvider(c.env);
  if (!provider) {
    return c.json({ errcode: 'M_UNKNOWN', error: 'No SSO provider configured' }, 501);
  }

  try {
    // Fetch OIDC discovery
    const discovery = await fetchOIDCDiscovery(provider.issuer_url);

    // Generate state and nonce
    const state = generateRandomString(32);
    const nonce = generateRandomString(32);

    // Generate PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Build our callback URI on the homeserver
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || c.env.SERVER_NAME;
    const protocol = c.req.header('x-forwarded-proto') || (c.req.url.startsWith('https') ? 'https' : 'http');
    const callbackUri = `${protocol}://${host}/auth/oidc/${provider.id}/callback`;

    // Store state in KV, including the client's redirectUrl as returnTo
    const stateData: OAuthState = {
      providerId: provider.id,
      nonce,
      redirectUri: callbackUri,
      returnTo: redirectUrl, // The client's redirect URL — will get sso_token fragment
      codeVerifier,
    };
    await c.env.SESSIONS.put(`oidc_state:${state}`, JSON.stringify(stateData), {
      expirationTtl: 600,
    });

    // Build authorization URL and redirect to IDP
    const authUrl = buildAuthorizationUrl(
      discovery,
      provider.client_id,
      callbackUri,
      provider.scopes,
      state,
      nonce,
      codeChallenge,
      'S256'
    );

    console.log('[SSO] Redirecting to IDP for login, redirectUrl:', redirectUrl);
    return c.redirect(authUrl);
  } catch (err) {
    console.error('[SSO] Failed to initiate SSO login:', err);
    return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to initiate SSO login' }, 500);
  }
});

// GET /_matrix/client/v1/auth_metadata - Get authentication metadata
// Returns information about supported authentication methods (MSC2965 / Matrix v1.17)
// This is the STABLE endpoint as of Matrix v1.17
app.get('/_matrix/client/v1/auth_metadata', async (c) => {
  const idpUrl = c.env.IDP_ISSUER;

  // When IDP-SERVER is configured, build auth metadata from IDP discovery
  if (idpUrl) {
    try {
      const resp = await fetch(`${idpUrl}/.well-known/openid-configuration`, {
        headers: { 'Accept': 'application/json' },
      });
      if (resp.ok) {
        const discovery = await resp.json() as Record<string, unknown>;
        return c.json({
          issuer: discovery.issuer,
          authorization_endpoint: discovery.authorization_endpoint,
          token_endpoint: discovery.token_endpoint,
          revocation_endpoint: discovery.revocation_endpoint,
          registration_endpoint: discovery.registration_endpoint,
          response_types_supported: discovery.response_types_supported || ['code'],
          response_modes_supported: discovery.response_modes_supported || ['query', 'fragment'],
          grant_types_supported: discovery.grant_types_supported || ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: discovery.code_challenge_methods_supported || ['S256'],
          token_endpoint_auth_methods_supported: [
            ...((discovery.token_endpoint_auth_methods_supported as string[]) || ['client_secret_basic']),
            ...(!((discovery.token_endpoint_auth_methods_supported as string[]) || []).includes('none') ? ['none'] : []),
          ],
          scopes_supported: [
            ...(discovery.scopes_supported as string[] || ['openid', 'profile', 'email']),
            'urn:matrix:org.matrix.msc2967.client:api:*',
            'urn:matrix:org.matrix.msc2967.client:device:*',
          ],
          account_management_uri: `${idpUrl}/account`,
          account_management_actions_supported: [
            'org.matrix.profile',
            'org.matrix.sessions_list',
            'org.matrix.session_view',
            'org.matrix.session_end',
          ],
          prompt_values_supported: discovery.prompt_values_supported || ['login', 'consent', 'create'],
        });
      }
    } catch (err) {
      console.error('[OIDC] Failed to proxy auth_metadata from IDP-SERVER:', err);
    }
  }

  // Fallback: local OAuth provider (no IDP configured)
  const serverName = c.env.SERVER_NAME;
  const baseUrl = `https://${serverName}`;

  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [
      'openid',
      'profile',
      'email',
      'urn:matrix:org.matrix.msc2967.client:api:*',
      'urn:matrix:org.matrix.msc2967.client:device:*',
    ],
    account_management_uri: `${baseUrl}/admin`,
    account_management_actions_supported: [
      'org.matrix.profile',
      'org.matrix.sessions_list',
      'org.matrix.session_view',
      'org.matrix.session_end',
      'org.matrix.cross_signing_reset',
    ],
    device_authorization_endpoint: `${baseUrl}/oauth/device`,
    prompt_values_supported: ['create'],
  });
});

// ============================================
// MSC3861 Identity Reset Endpoint
// ============================================

// Helper to get next stream position (same pattern as keys.ts)
async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  await db.prepare(`
    UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
  `).bind(streamName).run();

  const result = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = ?
  `).bind(streamName).first<{ position: number }>();

  return result?.position || 1;
}

// Helper to get Durable Object for user keys
function getUserKeysDO(env: any, userId: string) {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

// POST /_matrix/client/unstable/org.matrix.msc3861/account/identity/reset
// Allows OIDC users to reset their cross-signing identity
// Per MSC3861:
// 1. Requires OIDC re-authentication (valid access token)
// 2. Deletes all cross-signing keys for the user
// 3. Returns 200 on success
app.post('/_matrix/client/unstable/org.matrix.msc3861/account/identity/reset', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  try {
    // Delete cross-signing keys from Durable Object (primary storage)
    const stub = getUserKeysDO(c.env, userId);
    await stub.fetch(new Request('http://internal/cross-signing/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));

    // Delete cross-signing keys from D1 (backup storage)
    await db.prepare('DELETE FROM cross_signing_keys WHERE user_id = ?').bind(userId).run();

    // Delete cross-signing signatures
    await db.prepare('DELETE FROM cross_signing_signatures WHERE user_id = ? OR signer_user_id = ?').bind(userId, userId).run();

    // Delete from KV (cache)
    await c.env.CROSS_SIGNING_KEYS.delete(`user:${userId}`);

    // Record key change to trigger device list update for other users
    const streamPosition = await getNextStreamPosition(db, 'device_keys');
    await db.prepare(`
      INSERT INTO device_key_changes (user_id, device_id, change_type, stream_position)
      VALUES (?, NULL, 'cross_signing_reset', ?)
    `).bind(userId, streamPosition).run();

    console.log(`[OIDC] Cross-signing identity reset for user ${userId}`);

    // Return empty object on success per MSC3861
    return c.json({});
  } catch (err) {
    console.error(`[OIDC] Identity reset failed for ${userId}:`, err);
    return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to reset identity' }, 500);
  }
});

// Export encryption helpers for admin API
export { encryptSecret, decryptSecret };

export default app;
