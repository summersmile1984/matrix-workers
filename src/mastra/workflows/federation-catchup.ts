// Federation Catchup Workflow — Mastra version
//
// Replaces the CF WorkflowEntrypoint-based FederationCatchupWorkflow for self-hosted mode.
// Backfills events when a previously-offline server comes back online.
//
// The `env` object (DB) is received via requestContext.

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────────

const catchupInputSchema = z.object({
    serverName: z.string(),
    roomIds: z.array(z.string()),
});

const catchupOutputSchema = z.object({
    serverName: z.string(),
    backfilledEvents: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
});

// ── Steps ──────────────────────────────────────────────────────────────────────

/** Step 1: Verify remote server is reachable */
const checkServerStep = createStep({
    id: 'check-server',
    inputSchema: catchupInputSchema,
    outputSchema: z.object({
        reachable: z.boolean(),
        catchupInput: catchupInputSchema,
    }),
    execute: async ({ inputData }) => {
        try {
            const resp = await fetch(
                `https://${inputData.serverName}/_matrix/federation/v1/version`,
                { signal: AbortSignal.timeout(10000) },
            );
            return { reachable: resp.ok, catchupInput: inputData };
        } catch {
            return { reachable: false, catchupInput: inputData };
        }
    },
});

/** Step 2: Backfill missing events for each room */
const backfillStep = createStep({
    id: 'backfill-rooms',
    inputSchema: z.object({
        reachable: z.boolean(),
        catchupInput: catchupInputSchema,
    }),
    outputSchema: catchupOutputSchema,
    execute: async ({ inputData, requestContext }) => {
        const { reachable, catchupInput } = inputData;
        const { serverName, roomIds } = catchupInput;

        if (!reachable) {
            return {
                serverName,
                backfilledEvents: 0,
                success: false,
                error: 'Server not reachable',
            };
        }

        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available in requestContext');

        let totalBackfilled = 0;

        for (const roomId of roomIds) {
            try {
                // Get our latest event in this room
                const latestEvent = await env.DB.prepare(`
                    SELECT event_id FROM events WHERE room_id = ? ORDER BY stream_ordering DESC LIMIT 1
                `).bind(roomId).first();

                if (!latestEvent) continue;

                // Request missing events from the remote server
                const resp = await fetch(
                    `https://${serverName}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            limit: 100,
                            earliest_events: [latestEvent.event_id],
                            latest_events: [],
                        }),
                        signal: AbortSignal.timeout(30000),
                    },
                );

                if (!resp.ok) continue;

                const data = (await resp.json()) as { events?: unknown[] };
                totalBackfilled += data.events?.length || 0;
            } catch {
                // Continue with next room on failure
            }
        }

        return {
            serverName,
            backfilledEvents: totalBackfilled,
            success: true,
        };
    },
});

// ── Workflow definition ────────────────────────────────────────────────────────

export const federationCatchupWorkflow = createWorkflow({
    id: 'federation-catchup-workflow',
    inputSchema: catchupInputSchema,
    outputSchema: catchupOutputSchema,
})
    .then(checkServerStep)
    .then(backfillStep)
    .commit();
