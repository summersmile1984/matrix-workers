// Mastra instance initialization for self-hosted mode
//
// Configures Mastra with libSQL storage (shared with the rest of the app)
// and registers the workflow definitions.

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

import { roomJoinWorkflow } from './workflows/room-join';
import { pushNotificationWorkflow } from './workflows/push-notification';
import { federationCatchupWorkflow } from './workflows/federation-catchup';
import { mediaCleanupWorkflow } from './workflows/media-cleanup';
import { stateCompactionWorkflow } from './workflows/state-compaction';

/**
 * Create a Mastra instance configured with libSQL storage.
 *
 * The storage is shared with the main application — Mastra will create
 * its own tables (prefixed with `mastra_`) in the same database.
 */
export function createMastraInstance(libsqlUrl: string, libsqlToken?: string): Mastra {
    const storage = new LibSQLStore({
        id: 'matrix-workers',
        url: libsqlUrl,
        authToken: libsqlToken,
    });

    return new Mastra({
        storage,
        workflows: {
            roomJoinWorkflow,
            pushNotificationWorkflow,
            federationCatchupWorkflow,
            mediaCleanupWorkflow,
            stateCompactionWorkflow,
        },
    });
}
