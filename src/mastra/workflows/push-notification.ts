// Push Notification Workflow — Mastra version
//
// Replaces the CF WorkflowEntrypoint-based PushNotificationWorkflow for self-hosted mode.
// Logic is identical; only the orchestration layer differs.
//
// The `env` object (DB) is received via requestContext.

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────────

const pushInputSchema = z.object({
    eventId: z.string(),
    roomId: z.string(),
    eventType: z.string(),
    sender: z.string(),
    content: z.any(),
    originServerTs: z.number(),
});

const pushOutputSchema = z.object({
    success: z.boolean(),
    notifiedCount: z.number(),
    failedCount: z.number(),
    skippedCount: z.number(),
    error: z.string().optional(),
});

// ── Helper types ───────────────────────────────────────────────────────────────

interface RoomContext {
    memberCount: number;
    senderDisplayName: string;
    roomName: string | undefined;
}

interface SerializablePusher {
    pushkey: string;
    kind: string;
    appId: string;
    data: string;
}

// ── Helper functions (extracted from the original class methods) ────────────────

async function getRoomContext(db: any, roomId: string, sender: string): Promise<RoomContext> {
    const memberCountResult = await db.prepare(`
        SELECT COUNT(*) as count FROM room_memberships
        WHERE room_id = ? AND membership = 'join'
    `).bind(roomId).first();
    const memberCount = (memberCountResult as any)?.count || 0;

    const senderMembership = await db.prepare(`
        SELECT display_name FROM room_memberships
        WHERE room_id = ? AND user_id = ?
    `).bind(roomId, sender).first();
    const senderDisplayName = (senderMembership as any)?.display_name || sender.split(':')[0].replace('@', '');

    const roomNameEvent = await db.prepare(`
        SELECT content FROM events
        WHERE room_id = ? AND event_type = 'm.room.name' AND state_key = ''
        ORDER BY origin_server_ts DESC LIMIT 1
    `).bind(roomId).first();

    let roomName: string | undefined;
    if (roomNameEvent) {
        try {
            roomName = JSON.parse((roomNameEvent as any).content).name;
        } catch { }
    }
    if (!roomName && memberCount === 2) {
        roomName = senderDisplayName;
    }

    return { memberCount, senderDisplayName, roomName };
}

async function evaluatePushRules(
    db: any,
    userId: string,
    event: { type: string; content: any; sender: string; room_id: string },
): Promise<{ notify: boolean; actions: any[]; highlight: boolean }> {
    const masterRule = await db.prepare(`
        SELECT enabled FROM push_rules
        WHERE user_id = ? AND rule_id = '.m.rule.master'
    `).bind(userId).first();

    if ((masterRule as any)?.enabled === 1) {
        return { notify: false, actions: [], highlight: false };
    }

    if (event.type === 'm.room.message' || event.type === 'm.room.encrypted') {
        return { notify: true, actions: ['notify'], highlight: false };
    }

    return { notify: false, actions: [], highlight: false };
}

async function getUnreadCount(db: any, userId: string, roomId: string): Promise<number> {
    const result = await db.prepare(`
        SELECT COUNT(*) as count FROM events e
        WHERE e.room_id = ?
          AND e.stream_ordering > COALESCE(
            (SELECT CAST(json_extract(content, '$.event_id') AS TEXT) FROM account_data
             WHERE user_id = ? AND room_id = ? AND event_type = 'm.fully_read'),
            ''
          )
          AND e.sender != ?
          AND e.event_type IN ('m.room.message', 'm.room.encrypted')
    `).bind(roomId, userId, roomId, userId).first();
    return (result as any)?.count || 1;
}

async function getUserPushers(db: any, userId: string): Promise<SerializablePusher[]> {
    const result = await db.prepare(`
        SELECT pushkey, kind, app_id, data FROM pushers WHERE user_id = ?
    `).bind(userId).all();

    return (result as any).results.map((p: any) => ({
        pushkey: p.pushkey,
        kind: p.kind,
        appId: p.app_id,
        data: p.data,
    }));
}

async function sendToPusher(
    db: any,
    userId: string,
    pusher: SerializablePusher,
    eventContext: {
        eventId: string; roomId: string; eventType: string; sender: string;
        content: any; senderDisplayName: string; roomName: string | undefined;
    },
    unreadCount: number,
): Promise<boolean> {
    if (pusher.kind !== 'http') return false;

    let pusherData: any;
    try { pusherData = JSON.parse(pusher.data); } catch { return false; }
    if (!pusherData.url) return false;

    const deviceData = JSON.parse(JSON.stringify(pusherData.default_payload || {}));
    if (deviceData.aps) {
        if (eventContext.eventType === 'm.room.encrypted') {
            deviceData.aps.alert = {
                title: eventContext.senderDisplayName,
                body: eventContext.roomName || 'Chat',
            };
        } else {
            deviceData.aps.alert = {
                title: eventContext.senderDisplayName,
                subtitle: eventContext.roomName || 'Chat',
                body: eventContext.content?.body || 'New message',
            };
        }
        deviceData.aps['mutable-content'] = 1;
    }

    deviceData.event_id = eventContext.eventId;
    deviceData.room_id = eventContext.roomId;
    deviceData.sender = eventContext.sender;
    deviceData.unread_count = unreadCount;

    const notification = {
        notification: {
            event_id: eventContext.eventId,
            room_id: eventContext.roomId,
            type: eventContext.eventType,
            sender: eventContext.sender,
            sender_display_name: eventContext.senderDisplayName,
            room_name: eventContext.roomName || 'Chat',
            prio: 'high',
            counts: { unread: unreadCount },
            devices: [{
                app_id: pusher.appId,
                pushkey: pusher.pushkey,
                pushkey_ts: Date.now(),
                data: {
                    format: pusherData.format,
                    default_payload: deviceData,
                },
            }],
            ...(pusherData.format !== 'event_id_only' && { content: eventContext.content }),
        },
    };

    try {
        const response = await fetch(pusherData.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notification),
        });

        if (response.ok) {
            await db.prepare(`
                UPDATE pushers SET last_success = ?, failure_count = 0
                WHERE user_id = ? AND pushkey = ? AND app_id = ?
            `).bind(Date.now(), userId, pusher.pushkey, pusher.appId).run();
            return true;
        } else {
            await db.prepare(`
                UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
                WHERE user_id = ? AND pushkey = ? AND app_id = ?
            `).bind(Date.now(), userId, pusher.pushkey, pusher.appId).run();
            return false;
        }
    } catch (error) {
        await db.prepare(`
            UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
            WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `).bind(Date.now(), userId, pusher.pushkey, pusher.appId).run();
        throw error;
    }
}

async function queueNotification(
    db: any,
    userId: string,
    eventContext: { eventId: string; roomId: string },
    pushResult: { highlight: boolean; actions: any[] },
): Promise<void> {
    await db.prepare(`
        INSERT INTO notification_queue (user_id, room_id, event_id, notification_type, actions)
        VALUES (?, ?, ?, ?, ?)
    `).bind(
        userId,
        eventContext.roomId,
        eventContext.eventId,
        pushResult.highlight ? 'highlight' : 'notify',
        JSON.stringify(pushResult.actions),
    ).run();
}

// ── Steps ──────────────────────────────────────────────────────────────────────

/** Step 1: Get room members and context */
const gatherContextStep = createStep({
    id: 'gather-context',
    inputSchema: pushInputSchema,
    outputSchema: z.object({
        members: z.array(z.string()),
        roomContext: z.any(),
        pushInput: pushInputSchema,
    }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available');

        const result = await env.DB.prepare(`
            SELECT user_id FROM room_memberships
            WHERE room_id = ? AND membership = 'join' AND user_id != ?
        `).bind(inputData.roomId, inputData.sender).all();
        const members = (result as any).results.map((m: any) => m.user_id);

        if (members.length === 0) {
            return {
                members: [],
                roomContext: { memberCount: 0, senderDisplayName: '', roomName: undefined },
                pushInput: inputData,
            };
        }

        const roomCtx = await getRoomContext(env.DB, inputData.roomId, inputData.sender);

        return { members, roomContext: roomCtx, pushInput: inputData };
    },
});

/** Step 2: Process all members and send notifications */
const processAndNotifyStep = createStep({
    id: 'process-and-notify',
    inputSchema: z.object({
        members: z.array(z.string()),
        roomContext: z.any(),
        pushInput: pushInputSchema,
    }),
    outputSchema: pushOutputSchema,
    retries: 2,
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available');

        const { members, roomContext, pushInput } = inputData;

        if (members.length === 0) {
            return { success: true, notifiedCount: 0, failedCount: 0, skippedCount: 0 };
        }

        let notifiedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        // Process in batches of 50
        const BATCH_SIZE = 50;
        for (let i = 0; i < members.length; i += BATCH_SIZE) {
            const batch = members.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(
                batch.map(async (userId: string) => {
                    try {
                        const pushResult = await evaluatePushRules(env.DB, userId, {
                            type: pushInput.eventType,
                            content: pushInput.content,
                            sender: pushInput.sender,
                            room_id: pushInput.roomId,
                        });

                        if (!pushResult.notify) {
                            return { notified: false, skipped: true };
                        }

                        const unreadCount = await getUnreadCount(env.DB, userId, pushInput.roomId);
                        const pushers = await getUserPushers(env.DB, userId);

                        if (pushers.length === 0) {
                            return { notified: false, skipped: true };
                        }

                        let anySuccess = false;
                        for (const pusher of pushers) {
                            try {
                                const success = await sendToPusher(env.DB, userId, pusher, {
                                    eventId: pushInput.eventId,
                                    roomId: pushInput.roomId,
                                    eventType: pushInput.eventType,
                                    sender: pushInput.sender,
                                    content: pushInput.content,
                                    senderDisplayName: roomContext.senderDisplayName,
                                    roomName: roomContext.roomName,
                                }, unreadCount);
                                if (success) anySuccess = true;
                            } catch (err) {
                                console.error('[PushNotificationWorkflow] Pusher failed', {
                                    userId, appId: pusher.appId,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            }
                        }

                        await queueNotification(env.DB, userId, {
                            eventId: pushInput.eventId,
                            roomId: pushInput.roomId,
                        }, pushResult);

                        return { notified: anySuccess, skipped: false };
                    } catch (error) {
                        console.error('[PushNotificationWorkflow] Member failed', {
                            userId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return { notified: false, skipped: false, error: true };
                    }
                }),
            );

            for (const r of batchResults) {
                if (r.skipped) skippedCount++;
                else if (r.notified) notifiedCount++;
                else if ((r as any).error) failedCount++;
            }
        }

        console.log('[PushNotificationWorkflow] Completed', {
            eventId: pushInput.eventId,
            roomId: pushInput.roomId,
            notifiedCount, failedCount, skippedCount,
        });

        return { success: true, notifiedCount, failedCount, skippedCount };
    },
});

// ── Workflow definition ────────────────────────────────────────────────────────

export const pushNotificationWorkflow = createWorkflow({
    id: 'push-notification-workflow',
    inputSchema: pushInputSchema,
    outputSchema: pushOutputSchema,
})
    .then(gatherContextStep)
    .then(processAndNotifyStep)
    .commit();
