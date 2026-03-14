/**
 * IDP JWT Verification for Matrix Workers
 *
 * Verifies JWTs issued by the Matrix IDP using JWKS (public key verification).
 * This replaces token introspection, eliminating the need for client_secret.
 *
 * Uses the existing JWKS infrastructure from services/oidc.ts (Web Crypto API).
 */

import { fetchOIDCDiscovery, fetchJWKS, decodeJWT } from './oidc';
import type { JWKS, JWK } from './oidc';

export interface IdpJwtClaims {
    sub: string;
    email?: string;
    name?: string;
    iss?: string;
    scope?: string;
}

/**
 * Import a JWK as a CryptoKey for verification (Web Crypto API)
 */
async function importJWK(jwk: JWK): Promise<CryptoKey> {
    const algorithm = jwk.alg || 'RS256';

    let importAlgorithm: any;

    if (algorithm.startsWith('RS') || algorithm.startsWith('PS')) {
        importAlgorithm = {
            name: algorithm.startsWith('PS') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
            hash: { name: `SHA-${algorithm.slice(-3)}` },
        };
    } else if (algorithm.startsWith('ES')) {
        const curves: Record<string, string> = {
            'ES256': 'P-256',
            'ES384': 'P-384',
            'ES512': 'P-521',
        };
        importAlgorithm = {
            name: 'ECDSA',
            namedCurve: curves[algorithm] || 'P-256',
        };
    } else if (algorithm === 'EdDSA') {
        importAlgorithm = { name: 'Ed25519' };
    } else {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    return await crypto.subtle.importKey(
        'jwk',
        jwk as JsonWebKey,
        importAlgorithm,
        false,
        ['verify']
    );
}

/**
 * Verify JWT signature against a JWKS
 */
async function verifySignature(token: string, jwks: JWKS): Promise<boolean> {
    const { header, signature } = decodeJWT(token);
    const parts = token.split('.');
    const signedData = `${parts[0]}.${parts[1]}`;

    // Find matching key
    let key: JWK | undefined;
    if (header.kid) {
        key = jwks.keys.find(k => k.kid === header.kid);
    }
    if (!key) {
        key = jwks.keys.find(k => k.alg === header.alg || !k.alg);
    }
    if (!key) {
        throw new Error('No matching key found in JWKS');
    }

    const cryptoKey = await importJWK({ ...key, alg: header.alg });

    const signatureBytes = Uint8Array.from(
        atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );

    const algorithm = header.alg;
    let verifyAlgorithm: any;

    if (algorithm.startsWith('RS')) {
        verifyAlgorithm = { name: 'RSASSA-PKCS1-v1_5' };
    } else if (algorithm.startsWith('PS')) {
        verifyAlgorithm = {
            name: 'RSA-PSS',
            saltLength: parseInt(algorithm.slice(-3)) / 8,
        };
    } else if (algorithm.startsWith('ES')) {
        verifyAlgorithm = {
            name: 'ECDSA',
            hash: { name: `SHA-${algorithm.slice(-3)}` },
        };
    } else if (algorithm === 'EdDSA') {
        verifyAlgorithm = { name: 'Ed25519' };
    } else {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    return await crypto.subtle.verify(
        verifyAlgorithm,
        cryptoKey,
        signatureBytes,
        new TextEncoder().encode(signedData)
    );
}

/**
 * Verify an IDP JWT token using JWKS (no client_secret needed).
 *
 * 1. Fetches OIDC discovery from the IDP issuer URL
 * 2. Fetches the JWKS (public keys)
 * 3. Verifies the JWT signature
 * 4. Validates issuer and expiration
 * 5. Returns the claims
 */
export async function verifyIdpJwt(
    token: string,
    idpIssuerUrl: string,
): Promise<IdpJwtClaims | null> {
    try {
        // Decode without verification first
        const { payload } = decodeJWT(token);

        // Fetch JWKS from the IDP
        const discovery = await fetchOIDCDiscovery(idpIssuerUrl);
        const jwks = await fetchJWKS(discovery.jwks_uri);

        // Verify signature
        const signatureValid = await verifySignature(token, jwks);
        if (!signatureValid) {
            console.log('[IdpJwt] Invalid JWT signature');
            return null;
        }

        // Validate issuer — accept both with and without trailing slash
        const normalizedIssuer = idpIssuerUrl.replace(/\/$/, '');
        const baseUrl = new URL(idpIssuerUrl).origin;
        const acceptedIssuers = [
            normalizedIssuer,
            normalizedIssuer + '/',
            baseUrl,
            baseUrl + '/',
        ];

        if (!acceptedIssuers.includes(payload.iss)) {
            console.log(`[IdpJwt] Invalid issuer: ${payload.iss}, expected one of: ${acceptedIssuers.join(', ')}`);
            return null;
        }

        // Validate expiration
        if (payload.exp && payload.exp < Date.now() / 1000) {
            console.log('[IdpJwt] Token expired');
            return null;
        }

        // Validate Audience
        const DOMAIN = process.env.DOMAIN || 'localhost';
        const expectedAudience = process.env.WORKER_URL || `https://hs.${DOMAIN}`;
        const aud = payload.aud;
        const hasValidAudience = Array.isArray(aud) ? aud.includes(expectedAudience) : aud === expectedAudience;
        
        if (!hasValidAudience) {
             console.log(`[IdpJwt] Invalid audience: ${aud}, expected: ${expectedAudience}`);
             return null;
        }

        if (!payload.sub) {
            console.log('[IdpJwt] Token has no sub claim');
            return null;
        }

        return {
            sub: payload.sub,
            email: payload.email,
            name: payload.name,
            iss: payload.iss,
            scope: payload.scope,
        };
    } catch (err) {
        console.error('[IdpJwt] JWT verification failed:', err);
        return null;
    }
}
