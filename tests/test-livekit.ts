import * as sdk from "matrix-js-sdk";
import crypto from 'crypto';

const HOMESERVER_URL = "http://localhost:8787";
// Random credentials for a test user
const username = `testuser_${crypto.randomBytes(4).toString('hex')}`;
const password = "password123";

async function main() {
    console.log(`[Test] Setting up client for ${HOMESERVER_URL}`);

    // We'll create a temporary client just to register
    const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

    let accessToken: string;
    let userId: string;

    try {
        console.log(`[Test] Registering user ${username}...`);
        const regRes = await tempClient.register(
            username,
            password,
            undefined,
            { type: "m.login.dummy" }
        );
        accessToken = regRes.access_token;
        userId = regRes.user_id;
        console.log(`[Test] Registered successfully: ${userId}`);
    } catch (e: any) {
        console.log(`[Test] Registration failed (maybe exists?). Trying login...`);
        const loginRes = await tempClient.loginWithPassword(username, password);
        accessToken = loginRes.access_token;
        userId = loginRes.user_id;
        console.log(`[Test] Logged in successfully: ${userId}`);
    }

    // Now instantiate the real client with the token
    const client = sdk.createClient({
        baseUrl: HOMESERVER_URL,
        accessToken: accessToken,
        userId: userId
    });

    console.log(`[Test] Starting Matrix client sync...`);
    await client.startClient({ initialSyncLimit: 1 });

    // Wait for the client to be ready
    await new Promise(resolve => client.once('sync', (state) => {
        if (state === 'PREPARED') resolve(true);
    }));

    console.log(`[Test] Client synced. Creating a test room...`);
    const room = await client.createRoom({ visibility: 'private' });
    const roomId = room.room_id;
    console.log(`[Test] Created room: ${roomId}`);

    console.log(`[Test] Requesting RTC transports (LiveKit credentials) for MSC4143 / MSC3860...`);

    try {
        // We use the raw HTTP client for the unstable RTC endpoints if SDK doesn't fully wrap MSC4143
        // Element Web calls: GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports
        console.log(`[Test] Fetching /_matrix/client/unstable/org.matrix.msc4143/rtc/transports...`);
        const transportsRes = await fetch(`${HOMESERVER_URL}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`, {
            headers: {
                "Authorization": `Bearer ${accessToken}`
            }
        });

        if (!transportsRes.ok) {
            throw new Error(`Failed to GET transports: ${transportsRes.status} ${await transportsRes.text()}`);
        }

        const transports = await transportsRes.json();
        console.log(`[Test] RTC Transports Response:\n${JSON.stringify(transports, null, 2)}`);

        // Element X style specific endpoint
        console.log(`[Test] Fetching SFU credentials via /livekit/get_token...`);
        const livekitTokenRes = await fetch(`${HOMESERVER_URL}/livekit/get_token`, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                room_id: roomId,
                device_id: client.getDeviceId() || `device_${Date.now()}`,
                openid_token: {
                    access_token: "mock_openid_token_" + Date.now(),
                    token_type: "Bearer",
                    matrix_server_name: "localhost:8787",
                    expires_in: 3600
                }
            })
        });

        if (!livekitTokenRes.ok) {
            throw new Error(`Failed to GET livekit token: ${livekitTokenRes.status} ${await livekitTokenRes.text()}`);
        }

        const livekitData = await livekitTokenRes.json();
        console.log(`[Test] LiveKit Token Response:\n${JSON.stringify(livekitData, null, 2)}`);

        if (livekitData.token) {
            // Decode the JWT loosely to verify it
            const [header, payload, signature] = livekitData.token.split('.');
            if (payload) {
                const decodedPayload = Buffer.from(payload, 'base64').toString('ascii');
                console.log(`[Test] Decoded Token Payload (LiveKit JWT):\n${JSON.stringify(JSON.parse(decodedPayload), null, 2)}`);
            }
        }
    } catch (e) {
        console.error(`[Test] Error during RTC verification:`, e);
    } finally {
        console.log(`[Test] Stopping client...`);
        client.stopClient();
        process.exit(0);
    }
}

main().catch(console.error);
