// Room Join Workflow — Mastra version
//
// Replaces the CF WorkflowEntrypoint-based RoomJoinWorkflow for self-hosted mode.
// Logic is identical; only the orchestration layer differs.
//
// The `env` object (DB, SYNC, SERVER_NAME) is received via requestContext.

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { generateEventId } from '../../utils/ids';
import {
    storeEvent,
    updateMembership,
    getRoomMembers,
    getStateEvent,
    getRoomEvents,
    getMembership,
} from '../../services/database';

// ── Schemas ────────────────────────────────────────────────────────────────────

const joinInputSchema = z.object({
    roomId: z.string(),
    userId: z.string(),
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
    isRemote: z.boolean(),
    remoteServer: z.string().optional(),
    reason: z.string().optional(),
});

const joinOutputSchema = z.object({
    eventId: z.string(),
    roomId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
});

// ── Steps ──────────────────────────────────────────────────────────────────────

/** Step 1: For remote joins, request a join template from the remote server */
const makeJoinStep = createStep({
    id: 'make-join',
    inputSchema: joinInputSchema,
    outputSchema: z.object({
        remoteEventTemplate: z.any().nullable(),
        joinInput: joinInputSchema,
    }),
    retries: 3,
    execute: async ({ inputData }) => {
        if (!inputData.isRemote || !inputData.remoteServer) {
            return { remoteEventTemplate: null, joinInput: inputData };
        }

        console.log('[RoomJoinWorkflow] Making make_join request', {
            remoteServer: inputData.remoteServer,
            roomId: inputData.roomId,
            userId: inputData.userId,
        });

        const url = `https://${inputData.remoteServer}/_matrix/federation/v1/make_join/${encodeURIComponent(inputData.roomId)}/${encodeURIComponent(inputData.userId)}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`make_join failed: ${response.status} ${errorText}`);
        }

        const template = await response.json() as { room_version: string; event: any };
        return { remoteEventTemplate: template, joinInput: inputData };
    },
});

/** Step 2: Create and sign the join event */
const createEventStep = createStep({
    id: 'create-event',
    inputSchema: z.object({
        remoteEventTemplate: z.any().nullable(),
        joinInput: joinInputSchema,
    }),
    outputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available in requestContext');

        const { joinInput, remoteEventTemplate } = inputData;

        let authEvents: string[] = [];
        let prevEvents: string[] = [];
        let depth = 1;

        if (remoteEventTemplate?.event) {
            authEvents = remoteEventTemplate.event.auth_events || [];
            prevEvents = remoteEventTemplate.event.prev_events || [];
            depth = remoteEventTemplate.event.depth || 1;
        } else {
            const createEvent = await getStateEvent(env.DB, joinInput.roomId, 'm.room.create');
            const joinRulesEvent = await getStateEvent(env.DB, joinInput.roomId, 'm.room.join_rules');
            const powerLevelsEvent = await getStateEvent(env.DB, joinInput.roomId, 'm.room.power_levels');
            const currentMembership = await getMembership(env.DB, joinInput.roomId, joinInput.userId);

            if (createEvent) authEvents.push(createEvent.event_id);
            if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
            if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
            if (currentMembership) authEvents.push(currentMembership.eventId);

            const { events: latestEvents } = await getRoomEvents(env.DB, joinInput.roomId, undefined, 1);
            prevEvents = latestEvents.map((e: any) => e.event_id);
            depth = (latestEvents[0]?.depth ?? 0) + 1;
        }

        const eventId = await generateEventId(env.SERVER_NAME);

        const memberContent: any = { membership: 'join' };
        if (joinInput.displayName) memberContent.displayname = joinInput.displayName;
        if (joinInput.avatarUrl) memberContent.avatar_url = joinInput.avatarUrl;
        if (joinInput.reason) memberContent.reason = joinInput.reason;

        const event = {
            event_id: eventId,
            room_id: joinInput.roomId,
            sender: joinInput.userId,
            type: 'm.room.member',
            state_key: joinInput.userId,
            content: memberContent,
            origin_server_ts: Date.now(),
            depth,
            auth_events: authEvents,
            prev_events: prevEvents,
        };

        return { event, joinInput };
    },
});

/** Step 3: Send signed event to remote server (for remote joins) */
const sendJoinStep = createStep({
    id: 'send-join',
    inputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    outputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    retries: 3,
    execute: async ({ inputData }) => {
        const { event, joinInput } = inputData;

        if (!joinInput.isRemote || !joinInput.remoteServer) {
            return inputData; // pass through for local joins
        }

        console.log('[RoomJoinWorkflow] Sending send_join request', {
            remoteServer: joinInput.remoteServer,
            roomId: joinInput.roomId,
            eventId: event.event_id,
        });

        const url = `https://${joinInput.remoteServer}/_matrix/federation/v1/send_join/${encodeURIComponent(joinInput.roomId)}/${encodeURIComponent(event.event_id)}`;

        const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`send_join failed: ${response.status} ${errorText}`);
        }

        return inputData;
    },
});

/** Step 4: Persist event and membership locally */
const persistStep = createStep({
    id: 'persist',
    inputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    outputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available');

        await storeEvent(env.DB, inputData.event);
        await updateMembership(
            env.DB,
            inputData.joinInput.roomId,
            inputData.joinInput.userId,
            'join',
            inputData.event.event_id,
        );

        return inputData;
    },
});

/** Step 5: Notify room members about the join */
const notifyMembersStep = createStep({
    id: 'notify-members',
    inputSchema: z.object({
        event: z.any(),
        joinInput: joinInputSchema,
    }),
    outputSchema: joinOutputSchema,
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available');

        const memberList = await getRoomMembers(env.DB, inputData.joinInput.roomId);
        const members = memberList.filter((m: any) => m.userId !== inputData.joinInput.userId);

        // Notify in batches of 50
        const BATCH_SIZE = 50;
        for (let i = 0; i < members.length; i += BATCH_SIZE) {
            const batch = members.slice(i, i + BATCH_SIZE);
            await Promise.all(
                batch.map(async (member: any) => {
                    try {
                        const doId = env.SYNC.idFromName(member.userId);
                        const stub = env.SYNC.get(doId);
                        await stub.fetch(new Request('http://internal/notify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                roomId: inputData.event.room_id,
                                eventId: inputData.event.event_id,
                                eventType: inputData.event.type,
                            }),
                        }));
                    } catch (err) {
                        console.error('[RoomJoinWorkflow] Failed to notify member', {
                            userId: member.userId,
                            error: err instanceof Error ? err.message : 'Unknown',
                        });
                    }
                }),
            );
        }

        console.log('[RoomJoinWorkflow] Completed', {
            roomId: inputData.joinInput.roomId,
            userId: inputData.joinInput.userId,
            eventId: inputData.event.event_id,
        });

        return {
            eventId: inputData.event.event_id,
            roomId: inputData.joinInput.roomId,
            success: true,
        };
    },
});

// ── Workflow definition ────────────────────────────────────────────────────────

export const roomJoinWorkflow = createWorkflow({
    id: 'room-join-workflow',
    inputSchema: joinInputSchema,
    outputSchema: joinOutputSchema,
})
    .then(makeJoinStep)
    .then(createEventStep)
    .then(sendJoinStep)
    .then(persistStep)
    .then(notifyMembersStep)
    .commit();
