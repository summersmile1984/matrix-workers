// Shim for the `cloudflare:workers` virtual module.
// In Cloudflare Workers runtime this is a built-in.
// When running under Bun (self-hosted mode), we provide minimal stubs.

// ── DurableObject base class ─────────────────────────────────────────────────
// DO classes extend this. The real class provides lifecycle hooks;
// our self-hosted DO namespace adapter bypasses them and calls fetch() directly.
export class DurableObject {
    // ctx and env are injected by the DO namespace adapter
    constructor(
        protected ctx: any,
        protected env: any,
    ) { }
}

// ── WorkflowEntrypoint base class ─────────────────────────────────────────────
// Workflows are not supported in self-hosted mode.
// Classes that extend this will simply never be invoked.
export class WorkflowEntrypoint {
    constructor(
        protected ctx: any,
        protected env: any,
    ) { }
    async run(_event: WorkflowEvent<any>, _step: WorkflowStep): Promise<void> {
        throw new Error('[WorkflowEntrypoint] Workflows are not supported in self-hosted mode.');
    }
}

// ── Workflow type stubs ───────────────────────────────────────────────────────
export interface WorkflowEvent<T = unknown> {
    payload: T;
    timestamp: Date;
    id: string;
}

export interface WorkflowStep {
    do<T>(name: string, fn: () => Promise<T>): Promise<T>;
    sleep(name: string, ms: number | string): Promise<void>;
    sleepUntil(name: string, date: Date): Promise<void>;
}
