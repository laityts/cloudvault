import type { FileMeta } from './types';

export interface CreateFileMetaInput {
  /** Optional pre-generated id (e.g. preserved from multipart create). Defaults to randomUUID. */
  id?: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  /** ISO timestamp; defaults to now. */
  uploadedAt?: string;
}

/**
 * Construct a fresh FileMeta with share fields nulled and downloads=0.
 * Replaces the duplicated 10-field literal at:
 *  - api/files.ts:handleDirectUpload, handleMultipartComplete
 *  - handlers/webdav.ts:handlePut, handleCopy
 */
export function createFileMeta(input: CreateFileMetaInput): FileMeta {
  return {
    id: input.id ?? crypto.randomUUID(),
    key: input.key,
    name: input.name,
    size: input.size,
    type: input.type,
    folder: input.folder,
    uploadedAt: input.uploadedAt ?? new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
    sha1: null,
    sha256: null,
  };
}
