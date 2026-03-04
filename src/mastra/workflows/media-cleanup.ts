// Media Cleanup Workflow — Mastra version
//
// Replaces the CF WorkflowEntrypoint-based MediaCleanupWorkflow for self-hosted mode.
// Cleans orphaned and expired media files based on retention policies.
//
// The `env` object (DB, MEDIA) is received via requestContext.

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas ────────────────────────────────────────────────────────────────────

const cleanupInputSchema = z.object({
    maxAgeDays: z.number().optional(),
    dryRun: z.boolean().optional(),
});

const cleanupOutputSchema = z.object({
    deletedCount: z.number(),
    freedBytes: z.number(),
    dryRun: z.boolean(),
    success: z.boolean(),
});

// ── Steps ──────────────────────────────────────────────────────────────────────

/** Step 1: Find expired / orphaned media entries */
const findExpiredStep = createStep({
    id: 'find-expired',
    inputSchema: cleanupInputSchema,
    outputSchema: z.object({
        expiredMedia: z.array(z.object({
            media_id: z.string(),
            content_type: z.string(),
            file_size: z.number(),
            created_at: z.number(),
        })),
        cleanupInput: cleanupInputSchema,
    }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        if (!env?.DB) throw new Error('env.DB not available in requestContext');

        const maxAgeDays = inputData.maxAgeDays ?? 90;
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

        const results = await env.DB.prepare(`
            SELECT media_id, content_type, file_size, created_at FROM media
            WHERE created_at < ? AND media_id NOT IN (
                SELECT DISTINCT json_extract(e.content, '$.url')
                FROM events e
                WHERE json_extract(e.content, '$.url') IS NOT NULL
                  AND json_extract(e.content, '$.url') LIKE 'mxc://%'
            )
            LIMIT 500
        `).bind(cutoff).all();

        return {
            expiredMedia: results.results ?? [],
            cleanupInput: inputData,
        };
    },
});

/** Step 2: Delete expired media from storage and database */
const deleteMediaStep = createStep({
    id: 'delete-media',
    inputSchema: z.object({
        expiredMedia: z.array(z.object({
            media_id: z.string(),
            content_type: z.string(),
            file_size: z.number(),
            created_at: z.number(),
        })),
        cleanupInput: cleanupInputSchema,
    }),
    outputSchema: cleanupOutputSchema,
    execute: async ({ inputData, requestContext }) => {
        const { expiredMedia, cleanupInput } = inputData;
        const dryRun = cleanupInput.dryRun ?? false;

        // In dry-run mode, only report what would be deleted
        if (dryRun) {
            const freedBytes = expiredMedia.reduce((sum, m) => sum + (m.file_size || 0), 0);
            return {
                deletedCount: expiredMedia.length,
                freedBytes,
                dryRun: true,
                success: true,
            };
        }

        const env = (requestContext as any).get('env');
        if (!env?.DB || !env?.MEDIA) throw new Error('env.DB / env.MEDIA not available');

        let deletedCount = 0;
        let freedBytes = 0;

        for (const media of expiredMedia) {
            try {
                await env.MEDIA.delete(media.media_id);
                await env.DB.prepare('DELETE FROM media WHERE media_id = ?')
                    .bind(media.media_id)
                    .run();
                deletedCount++;
                freedBytes += media.file_size || 0;
            } catch {
                // Continue with next media item on failure
            }
        }

        return { deletedCount, freedBytes, dryRun: false, success: true };
    },
});

// ── Workflow definition ────────────────────────────────────────────────────────

export const mediaCleanupWorkflow = createWorkflow({
    id: 'media-cleanup-workflow',
    inputSchema: cleanupInputSchema,
    outputSchema: cleanupOutputSchema,
})
    .then(findExpiredStep)
    .then(deleteMediaStep)
    .commit();
