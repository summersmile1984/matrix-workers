-- Self-hosted supplementary schema
-- Run after migrations/schema.sql when deploying outside Cloudflare

-- DO 存储表（替代 DurableObject ctx.storage KV API）
-- namespace 格式: "DO类名:实例名"，如 "SYNC:@alice:server.com"
CREATE TABLE IF NOT EXISTS do_storage (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_do_storage_ns ON do_storage(namespace);

-- DO alarm 表（替代 DurableObject ctx.storage.setAlarm()）
CREATE TABLE IF NOT EXISTS do_alarms (
  namespace    TEXT PRIMARY KEY,
  scheduled_at INTEGER NOT NULL
);

-- KV 存储表（替代 Cloudflare KV 的 6 个 namespace）
-- namespace: SESSIONS / DEVICE_KEYS / CACHE / CROSS_SIGNING_KEYS / ACCOUNT_DATA / ONE_TIME_KEYS
CREATE TABLE IF NOT EXISTS kv_store (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  expires_at INTEGER,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_kv_store_ns  ON kv_store(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_store_exp ON kv_store(expires_at) WHERE expires_at IS NOT NULL;
