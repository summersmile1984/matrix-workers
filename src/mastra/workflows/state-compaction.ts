// State Compaction Workflow — Mastra version
//
// Replaces the CF WorkflowEntrypoint-based StateCompactionWorkflow for self-hosted mode.
// Compacts auth chains and room state snapshots for large rooms.
//
// The `env` object (DB) is received via requestContext.

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────────

const compactionInputSchema = z.object({
    roomId: z.string(),
    maxAuthChainDepth: z.number().optional(),
});

const compactionOutputSchema = z.object({
    roomId: z.string(),
    prunedAuthEntries: z.number(),
    compactedStateEvents: z.number(),
    success: z.boolean(),
});

// ── Steps ──────────────────────────────────────────────────────────────────────

/** Step 1: Prune deep auth chain entries */
const pruneAuthChainStep = createStep({
    id: 'prune-auth-chain',
    inputSchema: compactionInputSchema,
    outputSchema: z.object({
        roomId: z.string(),
        prunedCount: z.number(),
        maxAuthChainDepth: z.number(),
    }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available in requestContext');

        const { roomId } = inputData;
        const maxDepth = inputData.maxAuthChainDepth ?? 100;

        // Find and delete redundant auth chain entries beyond maxDepth
        const result = await env.DB.prepare(`
            DELETE FROM event_auth_chain
            WHERE room_id = ? AND depth > ?
        `).bind(roomId, maxDepth).run();

        const prunedCount = result.meta?.changes || 0;

        return { roomId, prunedCount, maxAuthChainDepth: maxDepth };
    },
});

/** Step 2: Compact room_state by removing superseded entries */
const compactStateStep = createStep({
    id: 'compact-state',
    inputSchema: z.object({
        roomId: z.string(),
        prunedCount: z.number(),
        maxAuthChainDepth: z.number(),
    }),
    outputSchema: compactionOutputSchema,
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available in requestContext');

        const { roomId, prunedCount } = inputData;

        // Remove room_state entries where a newer event exists for the same (type, state_key)
        const result = await env.DB.prepare(`
            DELETE FROM room_state
            WHERE room_id = ? AND rowid NOT IN (
                SELECT MAX(rowid) FROM room_state
                WHERE room_id = ?
                GROUP BY event_type, state_key
            )
        `).bind(roomId, roomId).run();

        const compactedCount = result.meta?.changes || 0;

        return {
            roomId,
            prunedAuthEntries: prunedCount,
            compactedStateEvents: compactedCount,
            success: true,
        };
    },
});

// ── Workflow definition ────────────────────────────────────────────────────────

export const stateCompactionWorkflow = createWorkflow({
    id: 'state-compaction-workflow',
    inputSchema: compactionInputSchema,
    outputSchema: compactionOutputSchema,
})
    .then(pruneAuthChainStep)
    .then(compactStateStep)
    .commit();
