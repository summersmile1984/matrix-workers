// Integration test for FileSystemMediaStorage with binary content.
// Validates that the R2 replacement works correctly for:
//   - Storing and retrieving binary data (PNG, random bytes)
//   - Metadata persistence (content-type, custom metadata)
//   - ReadableStream body consumption
//   - Delete behavior
//   - Large file handling
//
// Run: bun test tests/media-storage.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { FileSystemMediaStorage } from '../src/adapters/fs-media-storage';
import { rm } from 'node:fs/promises';
import type { MediaStorage } from '../src/adapters/media-storage';

const TEST_DIR = '/tmp/matrix-media-test-' + Date.now();
let storage: MediaStorage;

// Helper: consume ReadableStream to Uint8Array
async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

// Minimal 1x1 red PNG (68 bytes)
const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
    0x44, 0xAE, 0x42, 0x60, 0x82,
]);

beforeAll(() => {
    storage = new FileSystemMediaStorage(TEST_DIR);
});

afterAll(async () => {
    // Clean up test directory
    await rm(TEST_DIR, { recursive: true, force: true });
});

describe('FileSystemMediaStorage', () => {

    // ── Binary put/get ──────────────────────────────────────────────────────

    test('put and get PNG binary data', async () => {
        const key = 'test-image-001';
        await storage.put(key, PNG_BYTES.buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { userId: '@alice:localhost', filename: 'red.png' },
        });

        const result = await storage.get(key);

        expect(result).not.toBeNull();
        expect(result!.httpMetadata?.contentType).toBe('image/png');
        expect(result!.customMetadata?.userId).toBe('@alice:localhost');
        expect(result!.customMetadata?.filename).toBe('red.png');

        // Verify binary content is identical
        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(PNG_BYTES.length);
        expect(Buffer.from(retrieved).equals(Buffer.from(PNG_BYTES))).toBe(true);
    });

    test('put and get random binary data (1KB)', async () => {
        const key = 'test-random-1kb';
        const randomData = crypto.getRandomValues(new Uint8Array(1024));

        await storage.put(key, randomData.buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'application/octet-stream' },
        });

        const result = await storage.get(key);
        expect(result).not.toBeNull();

        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(1024);
        expect(Buffer.from(retrieved).equals(Buffer.from(randomData))).toBe(true);
    });

    test('put and get large binary data (1MB)', async () => {
        const key = 'test-large-1mb';
        const largeData = crypto.getRandomValues(new Uint8Array(1024 * 1024));

        await storage.put(key, largeData.buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'video/mp4' },
            customMetadata: { uploadedAt: '1234567890' },
        });

        const result = await storage.get(key);
        expect(result).not.toBeNull();
        expect(result!.httpMetadata?.contentType).toBe('video/mp4');

        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(1024 * 1024);
        // Verify first and last 64 bytes match (faster than full comparison)
        expect(Buffer.from(retrieved.slice(0, 64)).equals(Buffer.from(largeData.slice(0, 64)))).toBe(true);
        expect(Buffer.from(retrieved.slice(-64)).equals(Buffer.from(largeData.slice(-64)))).toBe(true);
    });

    // ── ReadableStream input ────────────────────────────────────────────────

    test('put accepts ReadableStream as value', async () => {
        const key = 'test-stream-input';
        const data = new TextEncoder().encode('Hello from a ReadableStream!');
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(data);
                controller.close();
            },
        });

        await storage.put(key, stream, {
            httpMetadata: { contentType: 'text/plain' },
        });

        const result = await storage.get(key);
        expect(result).not.toBeNull();

        const retrieved = await streamToBytes(result!.body);
        expect(new TextDecoder().decode(retrieved)).toBe('Hello from a ReadableStream!');
    });

    // ── Metadata-only ───────────────────────────────────────────────────────

    test('put with no metadata works', async () => {
        const key = 'test-no-meta';
        const data = new Uint8Array([0x00, 0xFF, 0x42]);

        await storage.put(key, data.buffer as ArrayBuffer);

        const result = await storage.get(key);
        expect(result).not.toBeNull();
        // No metadata is fine — should not throw
        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(3);
    });

    // ── Get non-existent ────────────────────────────────────────────────────

    test('get returns null for non-existent key', async () => {
        const result = await storage.get('does-not-exist');
        expect(result).toBeNull();
    });

    // ── Delete ──────────────────────────────────────────────────────────────

    test('delete removes the object', async () => {
        const key = 'test-delete';
        await storage.put(key, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);

        // Verify it exists
        let result = await storage.get(key);
        expect(result).not.toBeNull();

        // Delete
        await storage.delete(key);

        // Verify it's gone
        result = await storage.get(key);
        expect(result).toBeNull();
    });

    test('delete non-existent key does not throw', async () => {
        // Should not throw
        await storage.delete('never-existed');
    });

    // ── Binary integrity edge cases ─────────────────────────────────────────

    test('handles null bytes in binary data', async () => {
        const key = 'test-null-bytes';
        // Data with lots of null bytes (common in binary formats)
        const data = new Uint8Array(256);
        for (let i = 0; i < 256; i++) data[i] = i; // 0x00..0xFF

        await storage.put(key, data.buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'application/octet-stream' },
        });

        const result = await storage.get(key);
        expect(result).not.toBeNull();

        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(256);
        for (let i = 0; i < 256; i++) {
            expect(retrieved[i]).toBe(i);
        }
    });

    test('handles empty file', async () => {
        const key = 'test-empty';
        await storage.put(key, new ArrayBuffer(0));

        const result = await storage.get(key);
        expect(result).not.toBeNull();

        const retrieved = await streamToBytes(result!.body);
        expect(retrieved.length).toBe(0);
    });

    // ── Overwrite ──────────────────────────────────────────────────────────

    test('put overwrites existing content', async () => {
        const key = 'test-overwrite';

        // Write v1
        await storage.put(key, new TextEncoder().encode('version 1').buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'text/plain' },
        });

        // Overwrite with v2
        await storage.put(key, new TextEncoder().encode('version 2 is longer').buffer as ArrayBuffer, {
            httpMetadata: { contentType: 'text/html' },
        });

        const result = await storage.get(key);
        expect(result).not.toBeNull();
        expect(result!.httpMetadata?.contentType).toBe('text/html');

        const retrieved = await streamToBytes(result!.body);
        expect(new TextDecoder().decode(retrieved)).toBe('version 2 is longer');
    });
});
