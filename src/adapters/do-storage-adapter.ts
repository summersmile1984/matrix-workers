// DurableObjectStorage adapter for libSQL server
// Implements the KV-style ctx.storage API used by all Durable Objects in this project.
// All data is stored in the `do_storage` and `do_alarms` tables (see migrations/002_self_hosted.sql).

import { type Client, type InValue } from '@libsql/client/http';

export class LibSQLDOStorage {
    constructor(
        private client: Client,
        // Unique key identifying this DO instance, e.g. "SYNC:@alice:server.com"
        private namespace: string,
    ) { }

    // ── get ──────────────────────────────────────────────────────────────────

    async get<T = unknown>(key: string): Promise<T | undefined>;
    async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
    async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
        if (Array.isArray(keyOrKeys)) {
            const map = new Map<string, T>();
            for (const key of keyOrKeys) {
                const val = await this._getOne<T>(key);
                if (val !== undefined) map.set(key, val);
            }
            return map;
        }
        return this._getOne<T>(keyOrKeys);
    }

    private async _getOne<T>(key: string): Promise<T | undefined> {
        const rs = await this.client.execute({
            sql: 'SELECT value FROM do_storage WHERE namespace = ? AND key = ?',
            args: [this.namespace, key],
        });
        if (rs.rows.length === 0) return undefined;
        return JSON.parse(rs.rows[0][0] as string) as T;
    }

    // ── put ──────────────────────────────────────────────────────────────────

    async put<T = unknown>(key: string, value: T): Promise<void>;
    async put<T = unknown>(entries: Record<string, T>): Promise<void>;
    async put<T = unknown>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
        if (typeof keyOrEntries === 'string') {
            await this.client.execute({
                sql: 'INSERT OR REPLACE INTO do_storage (namespace, key, value) VALUES (?, ?, ?)',
                args: [this.namespace, keyOrEntries, JSON.stringify(value)],
            });
        } else {
            const stmts = Object.entries(keyOrEntries).map(([k, v]) => ({
                sql: 'INSERT OR REPLACE INTO do_storage (namespace, key, value) VALUES (?, ?, ?)',
                args: [this.namespace, k, JSON.stringify(v)] as InValue[],
            }));
            if (stmts.length > 0) await this.client.batch(stmts);
        }
    }

    // ── delete ────────────────────────────────────────────────────────────────

    async delete(key: string): Promise<boolean>;
    async delete(keys: string[]): Promise<number>;
    async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        const stmts = keys.map(k => ({
            sql: 'DELETE FROM do_storage WHERE namespace = ? AND key = ?',
            args: [this.namespace, k] as InValue[],
        }));
        if (stmts.length > 0) await this.client.batch(stmts);
        return Array.isArray(keyOrKeys) ? keys.length : true;
    }

    // ── list ──────────────────────────────────────────────────────────────────

    async list<T = unknown>(options?: {
        prefix?: string;
        start?: string;
        end?: string;
        limit?: number;
        reverse?: boolean;
    }): Promise<Map<string, T>> {
        let sql = 'SELECT key, value FROM do_storage WHERE namespace = ?';
        const args: InValue[] = [this.namespace];

        if (options?.prefix) { sql += ' AND key LIKE ?'; args.push(options.prefix + '%'); }
        if (options?.start) { sql += ' AND key >= ?'; args.push(options.start); }
        if (options?.end) { sql += ' AND key < ?'; args.push(options.end); }

        sql += options?.reverse ? ' ORDER BY key DESC' : ' ORDER BY key ASC';
        if (options?.limit) { sql += ' LIMIT ?'; args.push(options.limit); }

        const rs = await this.client.execute({ sql, args });
        const map = new Map<string, T>();
        for (const row of rs.rows) {
            map.set(row[0] as string, JSON.parse(row[1] as string) as T);
        }
        return map;
    }

    // ── alarm ─────────────────────────────────────────────────────────────────

    async setAlarm(scheduledTime: number | Date): Promise<void> {
        const ts = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
        await this.client.execute({
            sql: 'INSERT OR REPLACE INTO do_alarms (namespace, scheduled_at) VALUES (?, ?)',
            args: [this.namespace, ts],
        });
    }

    async getAlarm(): Promise<number | null> {
        const rs = await this.client.execute({
            sql: 'SELECT scheduled_at FROM do_alarms WHERE namespace = ?',
            args: [this.namespace],
        });
        return rs.rows.length > 0 ? (rs.rows[0][0] as number) : null;
    }

    async deleteAlarm(): Promise<void> {
        await this.client.execute({
            sql: 'DELETE FROM do_alarms WHERE namespace = ?',
            args: [this.namespace],
        });
    }

    // ── stubs (unused in this project but required for type compat) ───────────

    async sync(): Promise<void> { }

    async transaction<T>(fn: (txn: LibSQLDOStorage) => Promise<T>): Promise<T> {
        return fn(this);
    }
}
