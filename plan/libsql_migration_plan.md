# libSQL 自托管迁移执行计划

将 Cloudflare Workers 项目改造为可在自有服务器运行的版本，
用 libSQL server 替换 Cloudflare D1、KV、Durable Objects 存储。

---

## 关键架构说明

```
Cloudflare 部署（现在）：
  wrangler.jsonc → wrangler deploy → Cloudflare 管理所有 binding

自托管部署（目标）：
  package.json scripts → bun run src/server.ts → 进程自己组装 env 对象
```

`wrangler.jsonc` 是给 **Cloudflare 部署**的配置文件，告诉 CF 平台如何连接 D1/KV/DO 等资源。**自托管模式完全不走 wrangler**，因此 `wrangler.jsonc` **不需要也不应该修改**——两套部署方式并存，`wrangler.jsonc` 继续服务 CF 部署，新增的 `src/server.ts` 服务自托管部署。

`src/server.ts` 成为自托管入口的原因：通过 `package.json` 的 scripts 指定，`bun run src/server.ts` 直接启动这个文件，它内部用 `Bun.serve()` 起 HTTP 服务并手动构造 `env` 对象。

---

## 阶段 0：环境准备

### 0.1 安装 Bun 运行时

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# 验证
bun --version   # 应 ≥ 1.1.0
```

### 0.2 安装并启动 libSQL server（sqld）

**选项 A：Docker（推荐，最快）**

```bash
# 拉取镜像并启动，数据持久化到本地
docker run -d \
  --name sqld \
  -p 8080:8080 \
  -v $(pwd)/.data/sqld:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest

# 验证服务是否正常
curl http://localhost:8080/health   # 预期: {"status":"ok"}
```

**选项 B：直接下载二进制**

```bash
# macOS ARM
curl -LO https://github.com/tursodatabase/libsql/releases/latest/download/sqld-aarch64-apple-darwin.tar.gz
tar xf sqld-aarch64-apple-darwin.tar.gz
./sqld --http-listen-addr 0.0.0.0:8080 --db-path ./.data/matrix.db
```

> [!NOTE]
> libSQL server 默认无认证（开发模式）。生产环境需配置 `--auth-jwt-key`。
> 开发阶段保持无认证即可，`LIBSQL_TOKEN` 留空。

### 0.3 安装项目依赖

```bash
cd /Users/macstudio/Documents/matrix/matrix-workers

# 安装 libSQL 客户端
npm install @libsql/client

# 验证安装
node -e "const {createClient} = require('@libsql/client/http'); console.log('OK')"
```

---

## 阶段 1：数据库 Schema 初始化

### 1.1 新建 `migrations/002_self_hosted.sql`

在现有 `schema.sql` 基础上，自托管模式需要额外 3 张表：

```sql
-- DO 存储表（替代 DurableObject ctx.storage KV API）
CREATE TABLE IF NOT EXISTS do_storage (
  namespace TEXT NOT NULL,   -- DO 实例标识符，如 "SYNC:@alice:server.com"
  key       TEXT NOT NULL,   -- storage.put() 的 key
  value     TEXT NOT NULL,   -- JSON 序列化的值
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_do_storage_ns ON do_storage(namespace);

-- DO alarm 表（替代 DurableObject ctx.storage.setAlarm()）
CREATE TABLE IF NOT EXISTS do_alarms (
  namespace    TEXT PRIMARY KEY,
  scheduled_at INTEGER NOT NULL
);

-- KV 存储表（替代 Cloudflare KV 的 6 个 namespace：SESSIONS/DEVICE_KEYS/CACHE/...）
CREATE TABLE IF NOT EXISTS kv_store (
  namespace  TEXT NOT NULL,   -- KV 命名空间名，如 "SESSIONS"
  key        TEXT NOT NULL,   -- KV key
  value      TEXT,
  expires_at INTEGER,         -- Unix 毫秒时间戳，NULL 表示永不过期
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_kv_store_ns ON kv_store(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_store_exp ON kv_store(expires_at) WHERE expires_at IS NOT NULL;
```

### 1.2 执行迁移

```bash
# 确保 sqld 已启动（步骤 0.2）

# 执行主 schema
curl -s -X POST http://localhost:8080/v2/pipeline \
  -H "Content-Type: application/json" \
  -d "{\"requests\":[{\"type\":\"execute\",\"stmt\":{\"sql\":$(cat migrations/schema.sql | jq -Rs .)}}]}" \
  | jq '.results[0].type'  # 预期: "ok"

# 更简单的方式：用 libsql-shell（如已安装）
# libsql-shell http://localhost:8080 < migrations/schema.sql
# libsql-shell http://localhost:8080 < migrations/002_self_hosted.sql

# 或者用 wrangler 本地模式创建（它会用 Miniflare 本地 SQLite，不是 libSQL）
# 这个阶段先直接用 curl 方式，后续统一脚本化
```

> [!TIP]
> 实际操作建议写一个 `scripts/migrate-libsql.ts` 脚本来批量执行所有 .sql 文件，
> 在 Step 6 的 `package.json` 中作为 `npm run db:migrate:local` 脚本。

---

## 阶段 2：编写 4 个适配器文件

创建 `src/adapters/` 目录，在里面建以下文件：

---

### 2.1 `src/adapters/d1-adapter.ts`

实现 `D1Database` 接口，代理到 libSQL client。

覆盖的 D1 API（经代码扫描，项目中实际使用的）：
- `prepare(sql).bind(...val).all<T>()` — 所有 SELECT 多行
- `prepare(sql).bind(...val).first<T>()` — 所有 SELECT 单行
- `prepare(sql).bind(...val).run()` — 所有 INSERT/UPDATE/DELETE
- `batch([stmt1, stmt2])` — `room-cache.ts:141`、`sliding-sync.ts:395` 使用

```typescript
import { createClient, type Client, type InValue } from '@libsql/client/http';
import type { D1Database, D1Result, D1ExecResult } from '@cloudflare/workers-types';

class LibSQLStatement {
  // 用 protected 而非 private，方便 batch() 访问
  protected _sql: string;
  protected _args: InValue[] = [];

  constructor(private client: Client, sql: string) {
    this._sql = sql;
  }

  bind(...values: unknown[]): this {
    this._args = values as InValue[];
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rs = await this.client.execute({ sql: this._sql, args: this._args });
    const results = rs.rows.map(row => {
      const obj: Record<string, unknown> = {};
      rs.columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
      return obj as T;
    });
    return {
      results,
      success: true,
      meta: { duration: 0, size_after: 0, rows_read: results.length, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 }
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    // 注意：不追加 LIMIT 1（避免与已有 LIMIT 子句冲突），直接取第一行
    const rs = await this.client.execute({ sql: this._sql, args: this._args });
    if (rs.rows.length === 0) return null;
    const obj: Record<string, unknown> = {};
    rs.columns.forEach((col, i) => { obj[col] = rs.rows[0][i] ?? null; });
    return obj as T;
  }

  async run(): Promise<D1Result> {
    const rs = await this.client.execute({ sql: this._sql, args: this._args });
    return {
      results: [],
      success: true,
      meta: {
        duration: 0, size_after: 0,
        rows_read: 0, rows_written: rs.rowsAffected,
        last_row_id: Number(rs.lastInsertRowid ?? 0),
        changed_db: rs.rowsAffected > 0, changes: rs.rowsAffected
      }
    };
  }
}

export class LibSQLD1Adapter {
  constructor(private client: Client) {}

  prepare(sql: string): LibSQLStatement {
    return new LibSQLStatement(this.client, sql);
  }

  async batch<T = Record<string, unknown>>(statements: LibSQLStatement[]): Promise<D1Result<T>[]> {
    const stmts = statements.map(s => ({ sql: s._sql, args: s._args }));
    const results = await this.client.batch(stmts);
    return results.map(rs => {
      const rows = rs.rows.map(row => {
        const obj: Record<string, unknown> = {};
        rs.columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
        return obj as T;
      });
      return {
        results: rows, success: true,
        meta: { duration: 0, size_after: 0, rows_read: rows.length, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 }
      };
    });
  }

  async dump(): Promise<ArrayBuffer> { throw new Error('dump() not supported in libSQL mode'); }
  async exec(_query: string): Promise<D1ExecResult> { throw new Error('Use prepare() instead of exec()'); }
}

export function createD1(url: string, authToken?: string): LibSQLD1Adapter {
  return new LibSQLD1Adapter(createClient({ url, authToken }));
}
```

---

### 2.2 `src/adapters/do-storage-adapter.ts`

实现 `DurableObjectStorage` 的 KV 子集（项目中实际用到的方法）。

```typescript
import { type Client, type InValue } from '@libsql/client/http';

export class LibSQLDOStorage {
  constructor(
    private client: Client,
    private namespace: string  // 格式: "DO类名:实例名"，如 "SYNC:@alice:server.com"
  ) {}

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

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const k of keys) {
      await this.client.execute({
        sql: 'DELETE FROM do_storage WHERE namespace = ? AND key = ?',
        args: [this.namespace, k],
      });
    }
    return Array.isArray(keyOrKeys) ? keys.length : true;
  }

  async list<T = unknown>(options?: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>> {
    let sql = 'SELECT key, value FROM do_storage WHERE namespace = ?';
    const args: InValue[] = [this.namespace];
    if (options?.prefix) { sql += ' AND key LIKE ?'; args.push(options.prefix + '%'); }
    if (options?.start)  { sql += ' AND key >= ?';   args.push(options.start); }
    if (options?.end)    { sql += ' AND key < ?';    args.push(options.end); }
    sql += options?.reverse ? ' ORDER BY key DESC' : ' ORDER BY key ASC';
    if (options?.limit)  { sql += ' LIMIT ?';        args.push(options.limit); }
    const rs = await this.client.execute({ sql, args });
    const map = new Map<string, T>();
    for (const row of rs.rows) map.set(row[0] as string, JSON.parse(row[1] as string) as T);
    return map;
  }

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
    return rs.rows.length > 0 ? rs.rows[0][0] as number : null;
  }

  async deleteAlarm(): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM do_alarms WHERE namespace = ?',
      args: [this.namespace],
    });
  }

  // 以下方法项目中未使用，返回空实现避免类型错误
  async transaction<T>(fn: (txn: any) => Promise<T>): Promise<T> { return fn(this); }
  async sync(): Promise<void> {}
}
```

---

### 2.3 `src/adapters/kv-adapter.ts`

实现 `KVNamespace` 接口（项目中实际用到的方法：`get/put/delete/list`）。

```typescript
import { type Client, type InValue } from '@libsql/client/http';

export class LibSQLKVNamespace {
  constructor(private client: Client, private namespace: string) {}

  async get(key: string): Promise<string | null>;
  async get(key: string, type: 'text'): Promise<string | null>;
  async get(key: string, type: 'json'): Promise<any>;
  async get(key: string, typeOrOptions?: string | { type?: string }): Promise<any> {
    const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
    const rs = await this.client.execute({
      sql: 'SELECT value, expires_at FROM kv_store WHERE namespace = ? AND key = ?',
      args: [this.namespace, key],
    });
    if (rs.rows.length === 0) return null;
    const [value, expiresAt] = rs.rows[0];
    if (expiresAt && (expiresAt as number) < Date.now()) {
      await this.delete(key);
      return null;
    }
    const str = value as string;
    if (type === 'json') return JSON.parse(str);
    return str;
  }

  async put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    let expiresAt: number | null = null;
    if (options?.expirationTtl) expiresAt = Date.now() + options.expirationTtl * 1000;
    else if (options?.expiration) expiresAt = options.expiration * 1000;
    await this.client.execute({
      sql: 'INSERT OR REPLACE INTO kv_store (namespace, key, value, expires_at) VALUES (?, ?, ?, ?)',
      args: [this.namespace, key, str, expiresAt as InValue],
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.execute({
      sql: 'DELETE FROM kv_store WHERE namespace = ? AND key = ?',
      args: [this.namespace, key],
    });
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<any> {
    let sql = 'SELECT key FROM kv_store WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?)';
    const args: InValue[] = [this.namespace, Date.now()];
    if (options?.prefix) { sql += ' AND key LIKE ?'; args.push(options.prefix + '%'); }
    sql += ' ORDER BY key ASC';
    if (options?.limit) { sql += ' LIMIT ?'; args.push(options.limit); }
    const rs = await this.client.execute({ sql, args });
    return { keys: rs.rows.map(r => ({ name: r[0] as string })), list_complete: true, cursor: '' };
  }

  async getWithMetadata<T>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    return { value: await this.get(key), metadata: null };
  }
}
```

---

### 2.4 `src/adapters/do-namespace-adapter.ts`

模拟 `DurableObjectNamespace`，在自托管模式下将 DO 实例运行在本地进程内。

```typescript
import { type Client } from '@libsql/client/http';
import { LibSQLDOStorage } from './do-storage-adapter';

// 单例 Map：同一 namespace 下同一 ID 的 DO 只创建一次
const instances = new Map<string, any>();

class LibSQLDOId {
  constructor(public readonly name: string) {}
  toString() { return this.name; }
  equals(other: any) { return other?.toString() === this.name; }
}

class LibSQLDOStub {
  constructor(private instance: any, public readonly id: LibSQLDOId) {}
  async fetch(request: Request): Promise<Response> {
    return this.instance.fetch(request);
  }
}

export function createDONamespace(
  client: Client,
  namespaceName: string,       // 如 "SYNC"，用于在 do_storage 里区分不同 DO 类型
  DOClass: new (ctx: any, env: any) => any,
  env: any
): any {
  return {
    idFromName(name: string) {
      return new LibSQLDOId(`${namespaceName}:${name}`);
    },
    idFromString(id: string) {
      return new LibSQLDOId(id);
    },
    newUniqueId() {
      return new LibSQLDOId(`${namespaceName}:${crypto.randomUUID()}`);
    },
    get(id: LibSQLDOId) {
      const key = id.toString();
      if (!instances.has(key)) {
        const storage = new LibSQLDOStorage(client, key);
        const ctx = {
          storage,
          id,
          waitUntil: (promise: Promise<any>) => promise.catch(console.error),
          blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
          // DO alarm 处理（自托管版本：用 setInterval 轮询）
        };
        instances.set(key, new DOClass(ctx, env));
      }
      return new LibSQLDOStub(instances.get(key)!, id);
    },
    // 集群扩展点：多节点时在这里改为通过一致性哈希路由到对应节点的 HTTP 端点
    // get(id) { return new RemoteDOStub(id, hashToNode(id)); }
  };
}
```

---

## 阶段 3：修改 `src/utils/crypto.ts` 的签名算法名

`NODE-ED25519` 是 Cloudflare Workers 专有名称，Bun 运行时下必须改为标准 `Ed25519`。

**受影响的 3 处**（都在 `src/utils/crypto.ts`）：

```diff
- { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as Ed25519Params
+ { name: 'Ed25519' }
```

具体改动行：
- 第 109 行：`generateKey` 参数
- 第 172 行：`importKey`（签名用的私钥）
- 第 230 行：`importKey`（验证用的公钥）
- 第 181 行：`sign` 的算法参数
- 第 244 行：`verify` 的算法参数

同时删除 `Ed25519Params` 接口定义（第 91-94 行），不再需要。

---

## 阶段 4：新建 `src/server.ts`（自托管入口）

```typescript
// 自托管启动入口
// 用法: bun run src/server.ts
// 环境变量: LIBSQL_URL, SERVER_NAME, [LIBSQL_TOKEN], 以及其他可选配置

import { createClient } from '@libsql/client/http';
import app from './index';
import { LibSQLD1Adapter } from './adapters/d1-adapter';
import { LibSQLKVNamespace } from './adapters/kv-adapter';
import { createDONamespace } from './adapters/do-namespace-adapter';
import { RoomDurableObject } from './durable-objects/RoomDurableObject';
import { SyncDurableObject } from './durable-objects/SyncDurableObject';
import { FederationDurableObject } from './durable-objects/FederationDurableObject';
import { AdminDurableObject } from './durable-objects/AdminDurableObject';
import { UserKeysDurableObject } from './durable-objects/UserKeysDurableObject';
import { PushDurableObject } from './durable-objects/PushDurableObject';
import { RateLimitDurableObject } from './durable-objects/RateLimitDurableObject';

// --- 必填环境变量检查 ---
if (!process.env.LIBSQL_URL) throw new Error('LIBSQL_URL is required');
if (!process.env.SERVER_NAME) throw new Error('SERVER_NAME is required');

const LIBSQL_URL   = process.env.LIBSQL_URL;
const LIBSQL_TOKEN = process.env.LIBSQL_TOKEN;  // 开发时可留空

// --- 创建 libSQL 连接 ---
const client = createClient({ url: LIBSQL_URL, authToken: LIBSQL_TOKEN });

// --- 组装 env 对象（与 wrangler.jsonc env 接口相同）---
// 先构造不含 DO 的 env，DO 命名空间创建时需要把完整 env 传给 DO 构造函数
const baseEnv: any = {
  // 数据库（替代 D1）
  DB: new LibSQLD1Adapter(client),

  // KV 命名空间（替代 Cloudflare KV）
  SESSIONS:           new LibSQLKVNamespace(client, 'SESSIONS'),
  DEVICE_KEYS:        new LibSQLKVNamespace(client, 'DEVICE_KEYS'),
  CACHE:              new LibSQLKVNamespace(client, 'CACHE'),
  CROSS_SIGNING_KEYS: new LibSQLKVNamespace(client, 'CROSS_SIGNING_KEYS'),
  ACCOUNT_DATA:       new LibSQLKVNamespace(client, 'ACCOUNT_DATA'),
  ONE_TIME_KEYS:      new LibSQLKVNamespace(client, 'ONE_TIME_KEYS'),

  // 媒体（暂 stub，Step 5 实现 MinIO 适配器）
  MEDIA: null,

  // 环境变量（对应 wrangler.jsonc vars + secrets）
  SERVER_NAME:         process.env.SERVER_NAME,
  SERVER_VERSION:      process.env.SERVER_VERSION || '0.1.0',
  LIVEKIT_API_KEY:     process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET:  process.env.LIVEKIT_API_SECRET,
  LIVEKIT_URL:         process.env.LIVEKIT_URL,
  TURN_KEY_ID:         process.env.TURN_KEY_ID,
  TURN_API_TOKEN:      process.env.TURN_API_TOKEN,
  OIDC_ENCRYPTION_KEY: process.env.OIDC_ENCRYPTION_KEY,
  APNS_KEY_ID:         process.env.APNS_KEY_ID,
  APNS_TEAM_ID:        process.env.APNS_TEAM_ID,
  APNS_PRIVATE_KEY:    process.env.APNS_PRIVATE_KEY,
  APNS_ENVIRONMENT:    process.env.APNS_ENVIRONMENT,

  // CF 专有 binding 降级（未使用时设为 null/stub）
  LIVEKIT_API:  null,  // VPC 服务，自托管时直接用环境变量中的 URL
  ANALYTICS:    null,  // CF Analytics Engine，自托管不支持
  AI:           null,  // Workers AI，自托管不支持
  EMAIL:        null,  // CF Email Service，自托管时用 SMTP（后续实现）

  // Workflow 降级（暂时跳过，后续可接 BullMQ）
  ROOM_JOIN_WORKFLOW: {
    create: async (params: any) => { console.warn('[Workflow] ROOM_JOIN not running, trigger manually'); }
  },
  PUSH_NOTIFICATION_WORKFLOW: {
    create: async (params: any) => { console.warn('[Workflow] PUSH not running'); }
  },
};

// DO 命名空间（依赖完整 env，最后构造）
baseEnv.ROOMS      = createDONamespace(client, 'ROOMS',      RoomDurableObject,       baseEnv);
baseEnv.SYNC       = createDONamespace(client, 'SYNC',       SyncDurableObject,       baseEnv);
baseEnv.FEDERATION = createDONamespace(client, 'FEDERATION', FederationDurableObject, baseEnv);
baseEnv.ADMIN      = createDONamespace(client, 'ADMIN',      AdminDurableObject,      baseEnv);
baseEnv.USER_KEYS  = createDONamespace(client, 'USER_KEYS',  UserKeysDurableObject,   baseEnv);
baseEnv.PUSH       = createDONamespace(client, 'PUSH',       PushDurableObject,       baseEnv);
baseEnv.RATE_LIMIT = createDONamespace(client, 'RATE_LIMIT', RateLimitDurableObject,  baseEnv);
baseEnv.CALL_ROOMS = createDONamespace(client, 'CALL_ROOMS', RoomDurableObject,       baseEnv); // CallRoomDurableObject

const env = baseEnv;

// --- 启动 HTTP 服务 ---
const port = parseInt(process.env.PORT || '8787');
Bun.serve({ port, fetch: (req) => app.fetch(req, env) });
console.log(`[matrix-workers] Self-hosted server running at http://localhost:${port}`);
console.log(`[matrix-workers] SERVER_NAME = ${env.SERVER_NAME}`);
console.log(`[matrix-workers] libSQL URL  = ${LIBSQL_URL}`);
```

---

## 阶段 5：更新 `package.json`

在现有 scripts 基础上追加：

```json
"scripts": {
  "dev":              "wrangler dev",
  "deploy":           "wrangler deploy",
  "db:migrate":       "wrangler d1 execute tuwunel-db --file=./migrations/schema.sql",
  "db:migrate:local": "wrangler d1 execute tuwunel-db --local --file=./migrations/schema.sql",

  "dev:local":        "LIBSQL_URL=http://localhost:8080 SERVER_NAME=localhost:8787 bun run src/server.ts",
  "start":            "bun run src/server.ts",
  "db:migrate:libsql":"bun run scripts/migrate-libsql.ts",

  "test":      "vitest",
  "typecheck": "tsc --noEmit",
  "lint":      "eslint src/"
},
"dependencies": {
  "@cloudflare/workers-types": "^4.20241127.0",
  "@libsql/client": "^0.14.0",
  "hono": "^4.6.0",
  "uuid": "^10.0.0"
}
```

> [!NOTE]
> `wrangler.jsonc` **完全不需要修改**。
> Cloudflare 部署走 `npm run dev` / `npm run deploy`，使用 `wrangler.jsonc`。
> 自托管走 `npm run dev:local` / `npm start`，使用环境变量 + `src/server.ts`，两套并存互不干扰。

---

## 阶段 6：可选 — 迁移脚本

新建 `scripts/migrate-libsql.ts` 方便批量执行 SQL 文件：

```typescript
import { createClient } from '@libsql/client/http';
import { readFileSync, readdirSync } from 'fs';

const url = process.env.LIBSQL_URL!;
const authToken = process.env.LIBSQL_TOKEN;
const client = createClient({ url, authToken });

const files = readdirSync('./migrations').sort().filter(f => f.endsWith('.sql'));
for (const file of files) {
  const sql = readFileSync(`./migrations/${file}`, 'utf-8');
  console.log(`Executing ${file}...`);
  // 按语句分割执行
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt + ';');
  }
  console.log(`  ✓ ${file}`);
}
console.log('Migration complete.');
```

---

## 验证清单

### 环境验证

```bash
# 1. libSQL server 健康检查
curl http://localhost:8080/health

# 2. 执行迁移
bun run db:migrate:libsql

# 3. 检查表是否创建成功
curl -s -X POST http://localhost:8080/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT name FROM sqlite_master WHERE type='\''table'\'' ORDER BY name"}}]}' \
  | jq '.results[0].response.result.rows[] | .[0]'

# 4. 启动服务
npm run dev:local
```

### API 验证

```bash
BASE=http://localhost:8787

# 注册
curl -s -X POST $BASE/_matrix/client/v3/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"pass123","auth":{"type":"m.login.dummy"}}' | jq .user_id

# 登录，取 token
TOKEN=$(curl -s -X POST $BASE/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"testuser"},"password":"pass123"}' \
  | jq -r .access_token)

# 创建房间
ROOM=$(curl -s -X POST $BASE/_matrix/client/v3/createRoom \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Test"}' | jq -r .room_id)

# 发消息（D1 写路径）
curl -s -X PUT "$BASE/_matrix/client/v3/rooms/$ROOM/send/m.room.message/1" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"msgtype":"m.text","body":"hello from libSQL"}' | jq .event_id

# Sync（D1 读 + DO KV 路径）
curl -s "$BASE/_matrix/client/v3/sync" -H "Authorization: Bearer $TOKEN" \
  | jq '.rooms.join | keys | length'  # 预期: 1

# 联邦签名密钥（验证 Ed25519 改名后可用）
curl -s $BASE/_matrix/key/v2/server | jq '{keys: .verify_keys | keys, sigs: .signatures | keys}'
```

### 持久化验证

```bash
# 重启服务后数据仍在
kill $(lsof -ti:8787 2>/dev/null) || true
sleep 1
npm run dev:local &
sleep 2
curl -s "$BASE/_matrix/client/v3/sync" -H "Authorization: Bearer $TOKEN" \
  | jq '.rooms.join | keys | length'   # 预期仍然是 1，不是 0
```
