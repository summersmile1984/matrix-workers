// DurableObjectNamespace adapter for self-hosted mode
// Runs DO instances in-process (single node).
// ── Cluster extension point ──────────────────────────────────────────────────
// To support multi-node clustering, replace the local `get()` implementation
// with consistent-hash routing that forwards requests via HTTP to the correct node:
//   get(id) { return new RemoteDOStub(resolveNode(id), id); }
// ─────────────────────────────────────────────────────────────────────────────

import { type Client } from '@libsql/client/http';
import { LibSQLDOStorage } from './do-storage-adapter';

// ─── Id ──────────────────────────────────────────────────────────────────────

class LibSQLDOId {
    constructor(public readonly name: string) { }
    toString() { return this.name; }
    equals(other: { toString(): string }) { return other.toString() === this.name; }
    get unique() { return false as const; }
}

// ─── Stub ─────────────────────────────────────────────────────────────────────

class LibSQLDOStub {
    constructor(
        private instance: { fetch(req: Request): Promise<Response> },
        public readonly id: LibSQLDOId,
    ) { }

    async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        const req = input instanceof Request ? input : new Request(input, init);
        return this.instance.fetch(req);
    }
}

// ─── In-process instance cache ────────────────────────────────────────────────
// Single Map shared across all namespaces; keyed by "NAMESPACE_NAME:instance_id"

const doInstances = new Map<string, { fetch(req: Request): Promise<Response> }>();

// ─── Namespace factory ────────────────────────────────────────────────────────

export function createDONamespace(
    client: Client,
    namespaceName: string,       // e.g. "SYNC" – used as prefix in do_storage
    DOClass: new (ctx: any, env: any) => any,
    env: any,
): any /* DurableObjectNamespace */ {
    return {
        idFromName(name: string): LibSQLDOId {
            return new LibSQLDOId(`${namespaceName}:${name}`);
        },

        idFromString(id: string): LibSQLDOId {
            return new LibSQLDOId(id);
        },

        newUniqueId(_options?: { jurisdiction?: string }): LibSQLDOId {
            return new LibSQLDOId(`${namespaceName}:${crypto.randomUUID()}`);
        },

        get(id: LibSQLDOId): LibSQLDOStub {
            const key = id.toString();
            if (!doInstances.has(key)) {
                const storage = new LibSQLDOStorage(client, key);
                const ctx = {
                    storage,
                    id,
                    waitUntil: (p: Promise<unknown>) => p.catch(e => console.error('[DO waitUntil]', e)),
                    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => fn(),
                    abort: (_reason?: string) => { },
                    // WebSocket stubs – hibernation API is not available in self-hosted mode
                    getWebSockets: () => [] as WebSocket[],
                    acceptWebSocket: (_ws: WebSocket, _tags?: string[]) => { },
                };
                doInstances.set(key, new DOClass(ctx, env));
            }
            return new LibSQLDOStub(doInstances.get(key)!, id);
        },

        jurisdiction(_jur: string): any { return this; },
    };
}
