// Migration script for libSQL server (self-hosted mode)
// Uses executeMultiple() to execute each SQL file atomically.
//
// Usage:
//   LIBSQL_URL=http://localhost:8080 bun run scripts/migrate-libsql.ts
//   npm run db:migrate:libsql

import { createClient } from '@libsql/client/http';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const url = process.env.LIBSQL_URL;
if (!url) throw new Error('LIBSQL_URL environment variable is required');

const authToken = process.env.LIBSQL_TOKEN;
const client = createClient({ url, authToken });

const migrationsDir = join(import.meta.dir, '..', 'migrations');
const allFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

// Execution order:
//  1. schema.sql (base tables, always first)
//  2. numbered migrations in alphabetical order (002_phase1...015_...)
//  3. 002_self_hosted.sql (our DO/KV tables, last so schema.sql has run)
const numbered = allFiles
    .filter(f => f !== 'schema.sql' && f !== '002_self_hosted.sql')
    .sort();
const files = ['schema.sql', ...numbered, '002_self_hosted.sql'].filter(f =>
    allFiles.includes(f),
);

console.log(`[migrate] Running ${files.length} migration file(s) in order:`);
files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
console.log('');

for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`[migrate] Executing ${file}...`);
    try {
        // executeMultiple sends the whole file as one batch — preserves statement
        // order and handles multi-line strings/comments correctly.
        await client.executeMultiple(sql);
        console.log(`[migrate] ✓ ${file}`);
    } catch (err: any) {
        // Ignore "already exists" errors to stay idempotent
        if (err?.message?.includes('already exists')) {
            console.log(`[migrate] ✓ ${file} (tables/indexes already exist)`);
        } else {
            console.error(`[migrate] ✗ ${file} failed: ${err?.message}`);
            throw err;
        }
    }
}

console.log('\n[migrate] ✅ Migration complete — database is ready.');
