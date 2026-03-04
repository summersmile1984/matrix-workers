// S3-compatible MediaStorage implementation (skeleton).
// Intended for production self-hosted deployments using S3, MinIO, etc.
//
// Configuration via environment variables:
//   MEDIA_BACKEND=s3
//   S3_ENDPOINT=http://localhost:9000
//   S3_BUCKET=matrix-media
//   S3_ACCESS_KEY=...
//   S3_SECRET_KEY=...
//   S3_REGION=us-east-1          (optional, defaults to "auto")
//   S3_FORCE_PATH_STYLE=true     (optional, for MinIO compatibility)
//
// TODO: Implement using @aws-sdk/client-s3 or a lightweight S3 client.

import type { MediaStorage, MediaObject, MediaPutOptions } from './media-storage';

export class S3MediaStorage implements MediaStorage {
    constructor(private _config: {
        endpoint: string;
        bucket: string;
        accessKey: string;
        secretKey: string;
        region?: string;
        forcePathStyle?: boolean;
    }) { }

    async put(_key: string, _value: ArrayBuffer | ReadableStream, _options?: MediaPutOptions): Promise<void> {
        throw new Error('[S3MediaStorage] Not implemented yet. Install @aws-sdk/client-s3 and implement.');
    }

    async get(_key: string): Promise<MediaObject | null> {
        throw new Error('[S3MediaStorage] Not implemented yet.');
    }

    async delete(_key: string): Promise<void> {
        throw new Error('[S3MediaStorage] Not implemented yet.');
    }
}
