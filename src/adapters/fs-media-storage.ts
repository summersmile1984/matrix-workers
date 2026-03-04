// FileSystem-backed MediaStorage implementation for self-hosted mode.
// Stores objects as files on the local filesystem with companion .meta.json.
//
// Directory layout:
//   {basePath}/{key}           — raw object data
//   {basePath}/{key}.meta.json — { contentType, customMetadata }

import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaStorage, MediaObject, MediaPutOptions } from './media-storage';

interface FileMeta {
    contentType?: string;
    customMetadata?: Record<string, string>;
}

export class FileSystemMediaStorage implements MediaStorage {
    constructor(private basePath: string) { }

    // ── helpers ───────────────────────────────────────────────────────────────

    private filePath(key: string): string {
        return join(this.basePath, key);
    }

    private metaPath(key: string): string {
        return join(this.basePath, `${key}.meta.json`);
    }

    private async ensureDir(filePath: string): Promise<void> {
        await mkdir(dirname(filePath), { recursive: true });
    }

    // ── put ───────────────────────────────────────────────────────────────────

    async put(
        key: string,
        value: ArrayBuffer | ReadableStream,
        options?: MediaPutOptions,
    ): Promise<void> {
        const fp = this.filePath(key);
        await this.ensureDir(fp);

        // Resolve body to Buffer
        let buf: Buffer;
        if (value instanceof ArrayBuffer) {
            buf = Buffer.from(value);
        } else {
            // ReadableStream — consume fully
            const reader = (value as ReadableStream<Uint8Array>).getReader();
            const chunks: Uint8Array[] = [];
            for (; ;) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                chunks.push(chunk);
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.length;
            }
            buf = Buffer.from(merged);
        }

        await writeFile(fp, buf);

        // Write companion metadata
        const meta: FileMeta = {
            contentType: options?.httpMetadata?.contentType,
            customMetadata: options?.customMetadata,
        };
        await writeFile(this.metaPath(key), JSON.stringify(meta));
    }

    // ── get ───────────────────────────────────────────────────────────────────

    async get(key: string): Promise<MediaObject | null> {
        const fp = this.filePath(key);

        try {
            await stat(fp);
        } catch {
            return null; // file does not exist
        }

        const data = await readFile(fp);

        // Read optional metadata
        let meta: FileMeta = {};
        try {
            const raw = await readFile(this.metaPath(key), 'utf-8');
            meta = JSON.parse(raw);
        } catch {
            // no meta file — that's fine
        }

        // Convert Buffer to ReadableStream
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(data));
                controller.close();
            },
        });

        return {
            body,
            httpMetadata: meta.contentType ? { contentType: meta.contentType } : undefined,
            customMetadata: meta.customMetadata,
        };
    }

    // ── delete ────────────────────────────────────────────────────────────────

    async delete(key: string): Promise<void> {
        const fp = this.filePath(key);
        try {
            await unlink(fp);
        } catch {
            // already deleted or never existed — fine
        }
        try {
            await unlink(this.metaPath(key));
        } catch {
            // no meta file — fine
        }
    }
}
