// D1Database adapter for libSQL server
// NOTE: D1Database and D1PreparedStatement are `declare abstract class` in
// @cloudflare/workers-types — they are TYPE-ONLY (no runtime value in Bun).
// We cannot extend them; instead we implement the same interface structurally.
// TypeScript will still catch missing methods via assignment/type checks.

import { createClient, type Client, type InValue } from '@libsql/client/http';

// ─── Statement ───────────────────────────────────────────────────────────────

export class LibSQLStatement {
    protected _sql: string;
    protected _args: InValue[] = [];

    constructor(private client: Client, sql: string) {
        this._sql = sql;
    }

    // Exposed for batch()
    getStatement() { return { sql: this._sql, args: this._args }; }

    bind(...values: unknown[]): this {
        this._args = values as InValue[];
        return this;
    }

    // Overload: single column name → scalar
    first<T = unknown>(colName: string): Promise<T | null>;
    // Overload: no args → full row
    first<T = Record<string, unknown>>(): Promise<T | null>;
    async first<T>(colName?: string): Promise<T | null> {
        const rs = await this.client.execute({ sql: this._sql, args: this._args });
        if (rs.rows.length === 0) return null;
        if (colName !== undefined) {
            const idx = rs.columns.indexOf(colName);
            return (idx >= 0 ? rs.rows[0][idx] : null) as T | null;
        }
        const obj: Record<string, unknown> = {};
        rs.columns.forEach((col, i) => { obj[col] = rs.rows[0][i] ?? null; });
        return obj as T;
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rs = await this.client.execute({ sql: this._sql, args: this._args });
        return {
            results: [] as T[],
            success: true,
            meta: {
                duration: 0, size_after: 0,
                rows_read: 0, rows_written: rs.rowsAffected,
                last_row_id: Number(rs.lastInsertRowid ?? 0),
                changed_db: rs.rowsAffected > 0, changes: rs.rowsAffected,
            },
        };
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const rs = await this.client.execute({ sql: this._sql, args: this._args });
        const results = rs.rows.map(row => {
            const obj: Record<string, unknown> = {};
            rs.columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
            return obj as T;
        });
        return {
            results, success: true,
            meta: {
                duration: 0, size_after: 0,
                rows_read: results.length, rows_written: 0,
                last_row_id: 0, changed_db: false, changes: 0,
            },
        };
    }

    // raw() overload: with columnNames: true → [[col1, col2], ...rows]
    raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    // raw() overload: without → T[][]
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {
        const rs = await this.client.execute({ sql: this._sql, args: this._args });
        const rows = rs.rows.map(row => rs.columns.map((_, i) => row[i])) as T[];
        if (options?.columnNames === true) return [rs.columns, ...rows];
        return rows;
    }
}

// ─── D1Database ───────────────────────────────────────────────────────────────

export class LibSQLD1Adapter {
    constructor(private client: Client) { }

    prepare(sql: string): LibSQLStatement {
        return new LibSQLStatement(this.client, sql);
    }

    async batch<T = unknown>(statements: LibSQLStatement[]): Promise<D1Result<T>[]> {
        const stmts = statements.map(s => s.getStatement());
        const results = await this.client.batch(stmts);
        return results.map(rs => {
            const rows = rs.rows.map(row => {
                const obj: Record<string, unknown> = {};
                rs.columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
                return obj as T;
            });
            return {
                results: rows, success: true,
                meta: {
                    duration: 0, size_after: 0,
                    rows_read: rows.length, rows_written: 0,
                    last_row_id: 0, changed_db: false, changes: 0,
                },
            };
        });
    }

    async exec(_query: string): Promise<D1ExecResult> {
        throw new Error('[LibSQLD1Adapter] exec() not supported — use prepare()');
    }

    async dump(): Promise<ArrayBuffer> {
        throw new Error('[LibSQLD1Adapter] dump() not supported — use sqld admin API');
    }

    withSession(_constraint?: string): never {
        throw new Error('[LibSQLD1Adapter] withSession() not supported in self-hosted mode');
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createD1(url: string, authToken?: string): LibSQLD1Adapter {
    return new LibSQLD1Adapter(createClient({ url, authToken }));
}
