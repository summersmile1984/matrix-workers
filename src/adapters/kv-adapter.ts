// KVNamespace adapter for libSQL server
// Replaces Cloudflare KV with a `kv_store` table in libSQL.
// KVNamespace is an interface in @cloudflare/workers-types — we implement it.
// The interface has many typed overloads; the implementation signature uses
// loose types to satisfy all of them while keeping the code practical.

import { type Client, type InValue } from '@libsql/client/http';

export class LibSQLKVNamespace implements KVNamespace {
    constructor(
        private client: Client,
        private namespace: string, // e.g. "SESSIONS"
    ) { }

    // ── Internal helper ───────────────────────────────────────────────────────

    private async _getRaw(key: string): Promise<{ value: string | null; expiresAt: number | null }> {
        const rs = await this.client.execute({
            sql: 'SELECT value, expires_at FROM kv_store WHERE namespace = ? AND key = ?',
            args: [this.namespace, key],
        });
        if (rs.rows.length === 0) return { value: null, expiresAt: null };
        const value = rs.rows[0][0] as string | null;
        const expiresAt = rs.rows[0][1] as number | null;
        if (expiresAt !== null && expiresAt < Date.now()) {
            await this.delete(key);
            return { value: null, expiresAt: null };
        }
        return { value, expiresAt };
    }

    // ── get ───────────────────────────────────────────────────────────────────
    // Single implementation covers all KVNamespace.get() overloads.
    async get(key: string | string[], typeOrOptions?: unknown): Promise<any> {
        // Bulk get (array key)
        if (Array.isArray(key)) {
            const result = new Map<string, string | null>();
            for (const k of key) {
                const { value } = await this._getRaw(k);
                result.set(k, value);
            }
            return result;
        }

        const { value } = await this._getRaw(key);
        if (value === null) return null;

        const type = typeof typeOrOptions === 'string'
            ? typeOrOptions
            : (typeOrOptions as any)?.type;

        if (type === 'json') return JSON.parse(value);
        if (type === 'arrayBuffer') {
            const parsed = JSON.parse(value) as number[];
            return new Uint8Array(parsed).buffer;
        }
        if (type === 'stream') {
            const enc = new TextEncoder();
            return new ReadableStream({
                start(ctrl) { ctrl.enqueue(enc.encode(value)); ctrl.close(); },
            });
        }
        return value; // 'text' or undefined → string
    }

    // ── put ───────────────────────────────────────────────────────────────────

    async put(
        key: string,
        value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
        options?: KVNamespacePutOptions,
    ): Promise<void> {
        let str: string;
        if (typeof value === 'string') {
            str = value;
        } else if (value instanceof ArrayBuffer) {
            str = JSON.stringify(Array.from(new Uint8Array(value)));
        } else if (ArrayBuffer.isView(value)) {
            str = JSON.stringify(Array.from(new Uint8Array(value.buffer as ArrayBuffer)));
        } else {
            // ReadableStream — read fully
            const reader = (value as ReadableStream<Uint8Array>).getReader();
            const chunks: Uint8Array[] = [];
            let done = false;
            while (!done) {
                const res = await reader.read();
                if (res.done) { done = true; } else { chunks.push(res.value); }
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const buf = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) { buf.set(c, offset); offset += c.length; }
            str = new TextDecoder().decode(buf);
        }

        let expiresAt: number | null = null;
        if (options?.expirationTtl) expiresAt = Date.now() + options.expirationTtl * 1000;
        else if (options?.expiration) expiresAt = options.expiration * 1000;

        await this.client.execute({
            sql: 'INSERT OR REPLACE INTO kv_store (namespace, key, value, expires_at) VALUES (?, ?, ?, ?)',
            args: [this.namespace, key, str, expiresAt as InValue],
        });
    }

    // ── delete ────────────────────────────────────────────────────────────────

    async delete(key: string): Promise<void> {
        await this.client.execute({
            sql: 'DELETE FROM kv_store WHERE namespace = ? AND key = ?',
            args: [this.namespace, key],
        });
    }

    // ── list ──────────────────────────────────────────────────────────────────

    async list<Metadata = unknown>(
        options?: KVNamespaceListOptions,
    ): Promise<KVNamespaceListResult<Metadata, string>> {
        let sql =
            'SELECT key FROM kv_store WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?)';
        const args: InValue[] = [this.namespace, Date.now()];

        if (options?.prefix) { sql += ' AND key LIKE ?'; args.push(options.prefix + '%'); }
        sql += ' ORDER BY key ASC';
        if (options?.limit) { sql += ' LIMIT ?'; args.push(options.limit); }

        const rs = await this.client.execute({ sql, args });
        return {
            keys: rs.rows.map(r => ({ name: r[0] as string, expiration: undefined, metadata: undefined })),
            list_complete: true,
            cacheStatus: null,
        };
    }

    // ── getWithMetadata ───────────────────────────────────────────────────────

    // @ts-expect-error — covers all interface overloads via liberal typing
    async getWithMetadata(key: string | string[], typeOrOptions?: unknown): Promise<any> {
        if (Array.isArray(key)) {
            const result = new Map<string, KVNamespaceGetWithMetadataResult<string, unknown>>();
            for (const k of key) {
                const { value } = await this._getRaw(k);
                result.set(k, { value, metadata: null, cacheStatus: null });
            }
            return result;
        }
        const { value } = await this._getRaw(key);
        return { value, metadata: null, cacheStatus: null };
    }
}
