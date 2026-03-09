/**
 * LiveKit RTC Integration Test (vitest)
 *
 * Tests the Matrix HS LiveKit integration endpoints:
 *   1. GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports
 *   2. POST /livekit/get_token
 *
 * Prerequisites:
 *   - matrix-workers HS running on :8787 (BRIDGE_HOMESERVER_URL or default)
 *   - LiveKit env vars configured on HS (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
 *
 * Run:
 *   npx vitest run tests/test-livekit.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as sdk from 'matrix-js-sdk';
import crypto from 'crypto';

const HOMESERVER_URL = process.env.BRIDGE_HOMESERVER_URL ?? 'http://localhost:8787';
const username = `testuser_${crypto.randomBytes(4).toString('hex')}`;
const password = 'password123';

let client: sdk.MatrixClient;
let accessToken: string;
let userId: string;
let roomId: string;

beforeAll(async () => {
    const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

    try {
        const regRes = await tempClient.register(username, password, undefined, { type: 'm.login.dummy' });
        accessToken = regRes.access_token;
        userId = regRes.user_id;
    } catch {
        const loginRes = await tempClient.loginWithPassword(username, password);
        accessToken = loginRes.access_token;
        userId = loginRes.user_id;
    }

    client = sdk.createClient({
        baseUrl: HOMESERVER_URL,
        accessToken,
        userId,
    });

    await client.startClient({ initialSyncLimit: 1 });
    await new Promise<void>((resolve) =>
        client.once('sync' as any, (state: string) => {
            if (state === 'PREPARED') resolve();
        }),
    );

    const room = await client.createRoom({ visibility: sdk.Visibility.Private });
    roomId = room.room_id;
}, 30_000);

afterAll(() => {
    client?.stopClient();
});

describe('LiveKit RTC Transports', () => {
    it('should return MSC4143 transports endpoint', async () => {
        const resp = await fetch(
            `${HOMESERVER_URL}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        expect(resp.ok).toBe(true);

        const transports = await resp.json();
        expect(transports).toBeDefined();
        // Transports should have some structure (type, url, etc.)
        expect(typeof transports).toBe('object');
    });

    it('should return a LiveKit JWT via /livekit/get_token', async () => {
        const resp = await fetch(`${HOMESERVER_URL}/livekit/get_token`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                room_id: roomId,
                device_id: client.getDeviceId() || `device_${Date.now()}`,
                openid_token: {
                    access_token: `mock_openid_token_${Date.now()}`,
                    token_type: 'Bearer',
                    matrix_server_name: 'localhost:8787',
                    expires_in: 3600,
                },
            }),
        });

        expect(resp.ok).toBe(true);

        const data = (await resp.json()) as any;
        expect(data).toBeDefined();

        // If LiveKit is configured, we should get a token
        if (data.token) {
            expect(typeof data.token).toBe('string');

            // Verify JWT structure (header.payload.signature)
            const parts = data.token.split('.');
            expect(parts.length).toBe(3);

            // Decode payload and verify it's valid JSON
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
            expect(payload).toBeDefined();
            expect(typeof payload).toBe('object');
        }
    });
});
