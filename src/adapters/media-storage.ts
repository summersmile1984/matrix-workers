// MediaStorage interface — abstracts object storage for media files.
// In Cloudflare Workers mode the native R2Bucket binding is used directly.
// In self-hosted mode one of the concrete implementations below can be wired in.

// ── Types matching R2 shape ──────────────────────────────────────────────────

/** Returned by get(). Mirrors the subset of R2ObjectBody used by this project. */
export interface MediaObject {
    /** Readable stream of the object body */
    body: ReadableStream;
    /** HTTP metadata (content-type, etc.) */
    httpMetadata?: { contentType?: string };
    /** Arbitrary key-value metadata */
    customMetadata?: Record<string, string>;
}

/** Options for put(). Mirrors the subset of R2PutOptions used by this project. */
export interface MediaPutOptions {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Unified media storage interface.
 *
 * Any backend (local FS, S3/MinIO, GCS, Azure Blob, etc.) can implement this.
 * The interface matches the subset of R2Bucket actually used by media.ts,
 * admin.ts, and federation.ts — namely put, get, and delete.
 */
export interface MediaStorage {
    put(key: string, value: ArrayBuffer | ReadableStream, options?: MediaPutOptions): Promise<void>;
    get(key: string): Promise<MediaObject | null>;
    delete(key: string): Promise<void>;
}
