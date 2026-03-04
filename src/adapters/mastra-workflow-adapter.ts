// CF Workflow → Mastra Workflow adapter
//
// Bridges the Cloudflare Workflow API shape (env.WORKFLOW.create() → instance.status())
// to Mastra's workflow engine (createRun().start()), allowing business code (rooms.ts etc.)
// to remain unchanged while using Mastra for durable execution in self-hosted mode.

import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';

/** Mirrors the CF WorkflowInstance returned by Workflow.create() */
interface WorkflowInstance {
    id: string;
    status: () => Promise<{ status: string; output: unknown }>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    terminate: () => Promise<void>;
}

/**
 * Wraps a Mastra workflow to match the CF Workflow binding API.
 *
 * CF API:
 *   const instance = await env.MY_WORKFLOW.create({ params: { ... } });
 *   const status = await instance.status();
 *
 * Internally:
 *   const run = await workflow.createRun();
 *   const result = await run.start({ inputData: params, requestContext });
 *
 * Note: Mastra expects `requestContext` to be a `RequestContext` instance
 * (Map-like), not a plain object. Steps access env via requestContext.get('env').
 */
export function createMastraWorkflowBinding(
    mastra: Mastra,
    workflowKey: string,
    env: any,
) {
    return {
        create: async (params: { params?: unknown; id?: string } | unknown): Promise<WorkflowInstance> => {
            const workflow = mastra.getWorkflow(workflowKey);

            // CF Workflow.create() accepts { params: { ... } } or { id, params: { ... } }
            const inputData = (params as any)?.params ?? params;

            // Build a proper RequestContext (Map-like) with env inside
            const rc = new RequestContext([['env', env]]);

            const run = await workflow.createRun();
            const runId = (run as any).runId ?? crypto.randomUUID();

            // Execute asynchronously — don't block the caller
            const resultPromise = run.start({
                inputData,
                requestContext: rc as any,
            }).catch((err: any) => {
                console.error(`[MastraWorkflow] ${workflowKey} run failed:`, err);
                return {
                    status: 'failed' as const,
                    error: { message: err?.message ?? 'Unknown error' },
                    steps: {},
                    input: inputData,
                };
            });

            return {
                id: runId,

                status: async () => {
                    try {
                        const result = await resultPromise;

                        if (result.status === 'success') {
                            return {
                                status: 'complete',
                                output: result.result ?? { success: true },
                            };
                        }

                        return {
                            status: 'errored',
                            output: {
                                success: false,
                                error: (result as any).error?.message ?? `Workflow ${result.status}`,
                            },
                        };
                    } catch (err: any) {
                        return {
                            status: 'errored',
                            output: { success: false, error: err?.message ?? 'Unknown' },
                        };
                    }
                },

                pause: async () => { /* Mastra supports suspend — future */ },
                resume: async () => { /* Mastra supports resume — future */ },
                terminate: async () => { /* TODO */ },
            };
        },
    };
}
