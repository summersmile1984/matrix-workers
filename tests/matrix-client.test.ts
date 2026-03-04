// Matrix Client E2E Tests
// Comprehensive tests using matrix-js-sdk against the local homeserver.
// Covers: Registration, Login, Room Creation/DM, Room Join, Messaging, Calls.
//
// Prerequisites:
//   1. Local server running:  npm run dev:local
//   2. libSQL running:        sqld --grpc-listen-addr=0.0.0.0:8080
//   3. DB migrated:           npm run db:migrate:libsql
//
// Run:  bun test tests/matrix-client.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as sdk from 'matrix-js-sdk';
import crypto from 'crypto';

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8787';
const SERVER_NAME = process.env.SERVER_NAME || 'localhost:8787';

// Unique suffix per test run to avoid username collisions
const RUN_ID = crypto.randomBytes(4).toString('hex');

// ── Shared state across test suites ──────────────────────────────────────────

let aliceClient: sdk.MatrixClient;
let bobClient: sdk.MatrixClient;
let aliceUserId: string;
let bobUserId: string;
let aliceAccessToken: string;
let bobAccessToken: string;

let dmRoomId: string;
let publicRoomId: string;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function registerUser(username: string, password: string): Promise<{
    userId: string;
    accessToken: string;
    deviceId: string;
}> {
    const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

    try {
        const res = await tempClient.register(username, password, undefined, {
            type: 'm.login.dummy',
        });
        return {
            userId: res.user_id,
            accessToken: res.access_token!,
            deviceId: res.device_id!,
        };
    } catch (e: any) {
        // If UIA flow returns a 401 with session, complete it
        if (e.data?.session) {
            const res = await tempClient.register(username, password, e.data.session, {
                type: 'm.login.dummy',
                session: e.data.session,
            });
            return {
                userId: res.user_id,
                accessToken: res.access_token!,
                deviceId: res.device_id!,
            };
        }
        throw e;
    }
}

function createAuthenticatedClient(userId: string, accessToken: string): sdk.MatrixClient {
    return sdk.createClient({
        baseUrl: HOMESERVER_URL,
        accessToken,
        userId,
    });
}

// Waits for the client's first sync with a timeout
async function waitForSync(client: sdk.MatrixClient, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sync timeout')), timeoutMs);
        const onSync = (state: string) => {
            if (state === 'PREPARED' || state === 'SYNCING') {
                clearTimeout(timer);
                resolve();
            }
        };
        // Check if already synced
        if (client.isInitialSyncComplete()) {
            clearTimeout(timer);
            resolve();
            return;
        }
        client.once('sync' as any, onSync);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Registration
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. 用户注册 (Registration)', () => {

    test('registers user Alice successfully', async () => {
        const username = `alice_${RUN_ID}`;
        const result = await registerUser(username, 'password123');

        expect(result.userId).toBe(`@${username}:${SERVER_NAME}`);
        expect(result.accessToken).toBeDefined();
        expect(result.accessToken.length).toBeGreaterThan(0);
        expect(result.deviceId).toBeDefined();

        aliceUserId = result.userId;
        aliceAccessToken = result.accessToken;
        aliceClient = createAuthenticatedClient(aliceUserId, aliceAccessToken);
    });

    test('registers user Bob successfully', async () => {
        const username = `bob_${RUN_ID}`;
        const result = await registerUser(username, 'password456');

        expect(result.userId).toBe(`@${username}:${SERVER_NAME}`);
        expect(result.accessToken).toBeDefined();

        bobUserId = result.userId;
        bobAccessToken = result.accessToken;
        bobClient = createAuthenticatedClient(bobUserId, bobAccessToken);
    });

    test('rejects duplicate registration', async () => {
        const username = `alice_${RUN_ID}`;
        try {
            await registerUser(username, 'password123');
            // Should not reach here
            expect(true).toBe(false);
        } catch (e: any) {
            // M_USER_IN_USE
            expect(e.errcode || e.data?.errcode).toBe('M_USER_IN_USE');
        }
    });

    test('check username availability', async () => {
        // Taken username
        const takenRes = await fetch(
            `${HOMESERVER_URL}/_matrix/client/v3/register/available?username=alice_${RUN_ID}`
        );
        expect(takenRes.status).toBe(400);

        // Free username
        const freeRes = await fetch(
            `${HOMESERVER_URL}/_matrix/client/v3/register/available?username=unused_${RUN_ID}`
        );
        expect(freeRes.status).toBe(200);
        const freeBody = await freeRes.json() as any;
        expect(freeBody.available).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Login
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. 登录 (Login)', () => {

    test('login with correct password', async () => {
        const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });
        const result = await tempClient.login('m.login.password', {
            identifier: { type: 'm.id.user', user: `alice_${RUN_ID}` },
            password: 'password123',
        });

        expect(result.user_id).toBe(aliceUserId);
        expect(result.access_token).toBeDefined();
        expect(result.device_id).toBeDefined();
    });

    test('login with wrong password is rejected', async () => {
        const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });
        try {
            await tempClient.login('m.login.password', {
                identifier: { type: 'm.id.user', user: `alice_${RUN_ID}` },
                password: 'wrong_password',
            });
            expect(true).toBe(false); // should not reach
        } catch (e: any) {
            expect(e.httpStatus).toBe(403);
        }
    });

    test('get login flows', async () => {
        const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/login`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.flows).toBeDefined();
        expect(body.flows.length).toBeGreaterThan(0);

        const flowTypes = body.flows.map((f: any) => f.type);
        expect(flowTypes).toContain('m.login.password');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Room Creation & DM
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. 创建房间 & DM (Room Creation & Direct Message)', () => {

    test('Alice creates a DM room inviting Bob', async () => {
        const result = await aliceClient.createRoom({
            visibility: 'private' as any,
            is_direct: true,
            invite: [bobUserId],
            name: `DM ${RUN_ID}`,
        });

        expect(result.room_id).toBeDefined();
        expect(result.room_id).toMatch(/^!/);
        dmRoomId = result.room_id;
    });

    test('Alice sends a message in the DM', async () => {
        const txnId = `txn_${Date.now()}`;
        const result = await aliceClient.sendMessage(dmRoomId, {
            msgtype: 'm.text',
            body: 'Hello Bob! This is a DM test.',
        } as any);

        expect(result.event_id).toBeDefined();
        expect(result.event_id).toMatch(/^\$/);
    });

    test('Bob accepts the DM invite and sees the message', async () => {
        // Bob joins the DM (accepts the invite)
        await bobClient.joinRoom(dmRoomId);

        // Fetch messages
        const messages = await bobClient.createMessagesRequest(dmRoomId, undefined as any, 10, 'b');
        expect(messages.chunk).toBeDefined();

        // Find Alice's text message
        const textMessages = messages.chunk.filter(
            (e: any) => e.type === 'm.room.message' && e.content?.body
        );
        expect(textMessages.length).toBeGreaterThanOrEqual(1);

        const aliceMsg = textMessages.find(
            (e: any) => e.content.body === 'Hello Bob! This is a DM test.'
        );
        expect(aliceMsg).toBeDefined();
        expect(aliceMsg!.sender).toBe(aliceUserId);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Room Join
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. 加入房间 (Room Join)', () => {

    test('Alice creates a public room', async () => {
        const result = await aliceClient.createRoom({
            visibility: 'public' as any,
            name: `Test Room ${RUN_ID}`,
            topic: 'E2E test public room',
            preset: 'public_chat' as any,
        });

        expect(result.room_id).toBeDefined();
        publicRoomId = result.room_id;
    });

    test('Bob joins the public room', async () => {
        const result = await bobClient.joinRoom(publicRoomId);
        expect(result.roomId || (result as any).room_id).toBeDefined();
    });

    test('Bob sees the room in joined_rooms', async () => {
        const result = await bobClient.getJoinedRooms();
        expect(result.joined_rooms).toContain(publicRoomId);
    });

    test('room has both Alice and Bob as members', async () => {
        const res = await fetch(
            `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(publicRoomId)}/members`,
            { headers: { Authorization: `Bearer ${aliceAccessToken}` } }
        );
        expect(res.status).toBe(200);
        const body = await res.json() as any;

        const memberUserIds = body.chunk
            .filter((e: any) => e.content?.membership === 'join')
            .map((e: any) => e.state_key);

        expect(memberUserIds).toContain(aliceUserId);
        expect(memberUserIds).toContain(bobUserId);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Room Messaging
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. 房间对话 (Room Messaging)', () => {

    test('Alice sends a message in the public room', async () => {
        const result = await aliceClient.sendMessage(publicRoomId, {
            msgtype: 'm.text',
            body: `Hello from Alice! [${RUN_ID}]`,
        } as any);

        expect(result.event_id).toBeDefined();
    });

    test('Bob sends a reply in the public room', async () => {
        const result = await bobClient.sendMessage(publicRoomId, {
            msgtype: 'm.text',
            body: `Hi Alice, Bob here! [${RUN_ID}]`,
        } as any);

        expect(result.event_id).toBeDefined();
    });

    test('Alice retrieves messages and sees both messages', async () => {
        const messages = await aliceClient.createMessagesRequest(
            publicRoomId,
            undefined as any,
            20,
            'b'
        );

        expect(messages.chunk).toBeDefined();

        const textMessages = messages.chunk.filter(
            (e: any) => e.type === 'm.room.message' && e.content?.msgtype === 'm.text'
        );

        const bodies = textMessages.map((e: any) => e.content.body);
        expect(bodies).toContain(`Hello from Alice! [${RUN_ID}]`);
        expect(bodies).toContain(`Hi Alice, Bob here! [${RUN_ID}]`);
    });

    test('Bob retrieves messages and sees both messages', async () => {
        const messages = await bobClient.createMessagesRequest(
            publicRoomId,
            undefined as any,
            20,
            'b'
        );

        const textMessages = messages.chunk.filter(
            (e: any) => e.type === 'm.room.message' && e.content?.msgtype === 'm.text'
        );

        const bodies = textMessages.map((e: any) => e.content.body);
        expect(bodies).toContain(`Hello from Alice! [${RUN_ID}]`);
        expect(bodies).toContain(`Hi Alice, Bob here! [${RUN_ID}]`);
    });

    test('Alice sends an image message (m.image)', async () => {
        const result = await aliceClient.sendMessage(publicRoomId, {
            msgtype: 'm.image',
            body: 'test-image.png',
            url: `mxc://${SERVER_NAME}/fake_media_id_${RUN_ID}`,
            info: {
                mimetype: 'image/png',
                size: 1024,
                w: 100,
                h: 100,
            },
        } as any);

        expect(result.event_id).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Call Initiation (MatrixRTC / VoIP)
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. 发起通话 (Call Initiation)', () => {

    test('Alice gets TURN server credentials', async () => {
        const res = await fetch(
            `${HOMESERVER_URL}/_matrix/client/v3/voip/turnServer`,
            { headers: { Authorization: `Bearer ${aliceAccessToken}` } }
        );
        expect(res.status).toBe(200);

        const body = await res.json() as any;
        // Should return either TURN URIs or at least STUN URIs
        expect(body.uris || body.urls).toBeDefined();
        expect(body.ttl).toBeDefined();
    });

    test('Alice sends m.call.member state event to join call', async () => {
        const deviceId = aliceClient.getDeviceId() || `device_${RUN_ID}`;

        // Standard MatrixRTC approach: send m.call.member state event
        const result = await aliceClient.sendStateEvent(publicRoomId, 'm.call.member' as any, {
            memberships: [{
                application: 'org.matrix.msc3401.call',
                call_id: '',
                device_id: deviceId,
                expires_ts: Date.now() + 3600_000,
                foci_active: [{ type: 'livekit', livekit_alias: publicRoomId }],
            }],
        }, aliceUserId);

        expect(result.event_id).toBeDefined();
    });

    test('call membership is visible via room state', async () => {
        const state = await aliceClient.getStateEvent(publicRoomId, 'm.call.member' as any, aliceUserId);

        expect(state).toBeDefined();
        expect((state as any).memberships).toBeDefined();
        expect((state as any).memberships.length).toBeGreaterThanOrEqual(1);
        expect((state as any).memberships[0].application).toBe('org.matrix.msc3401.call');
    });

    test('Alice leaves the call by clearing memberships', async () => {
        // Clear memberships to leave the call
        const result = await aliceClient.sendStateEvent(publicRoomId, 'm.call.member' as any, {
            memberships: [],
        }, aliceUserId);

        expect(result.event_id).toBeDefined();
    });

    test('call membership is empty after leaving', async () => {
        const state = await aliceClient.getStateEvent(publicRoomId, 'm.call.member' as any, aliceUserId);

        expect(state).toBeDefined();
        expect((state as any).memberships).toBeDefined();
        expect((state as any).memberships.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

afterAll(async () => {
    // Leave rooms and logout
    try {
        if (aliceClient) {
            if (publicRoomId) await aliceClient.leave(publicRoomId).catch(() => { });
            if (dmRoomId) await aliceClient.leave(dmRoomId).catch(() => { });
            await aliceClient.logout(true).catch(() => { });
        }
        if (bobClient) {
            if (publicRoomId) await bobClient.leave(publicRoomId).catch(() => { });
            if (dmRoomId) await bobClient.leave(dmRoomId).catch(() => { });
            await bobClient.logout(true).catch(() => { });
        }
    } catch {
        // Best-effort cleanup
    }
});
