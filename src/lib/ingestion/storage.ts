/**
 * Where item images are kept: the two private Supabase Storage buckets.
 * Behind an interface so the ingestion logic can be tested with the
 * in-memory version.
 *
 * Only the server writes images (after checking them and stripping EXIF),
 * using the secret key, which bypasses storage RLS. So callers must build
 * keys from the signed-in user's ID (newImageKey) and check ownership of any
 * key a client sends (imageKeyBelongsTo).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { STORAGE_BUCKETS, type AcceptedImageType } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";

export type ImageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

export interface StoredObject {
  key: string;
  createdAt: Date;
}

export interface ImageStorage {
  /** Store a new image. Fails if the key is already taken. */
  upload(bucket: ImageBucket, key: string, image: ImageInput): Promise<void>;
  /** Delete images. Keys that don't exist are ignored. */
  remove(bucket: ImageBucket, keys: readonly string[]): Promise<void>;
  exists(bucket: ImageBucket, key: string): Promise<boolean>;
  /** Short-lived signed URLs, by key. Keys that can't be signed are left out. */
  signedUrls(bucket: ImageBucket, keys: readonly string[], ttlSeconds: number): Promise<Map<string, string>>;
  /** Top-level folders (one per user ID) in a bucket. */
  listFolders(bucket: ImageBucket): Promise<string[]>;
  /** Images in one folder, with their upload time. */
  listObjects(bucket: ImageBucket, folder: string): Promise<StoredObject[]>;
}

const EXTENSIONS: Readonly<Record<AcceptedImageType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** A fresh `<user id>/<uuid>.<ext>` key (ImageKeySchema). */
export function newImageKey(userId: string, mimeType: AcceptedImageType): string {
  return `${userId}/${crypto.randomUUID()}.${EXTENSIONS[mimeType]}`;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const LIST_PAGE_SIZE = 100;

/** Backed by Supabase Storage. Needs the admin (secret key) client: users can't upload directly. */
export class SupabaseImageStorage implements ImageStorage {
  constructor(private readonly admin: SupabaseClient) {}

  async upload(bucket: ImageBucket, key: string, image: ImageInput): Promise<void> {
    const { error } = await this.admin.storage.from(bucket).upload(key, image.data, {
      contentType: image.mimeType,
      upsert: false,
      cacheControl: "3600",
    });
    if (error) throw new Error(`Couldn't store the image in ${bucket}: ${error.message}`);
  }

  async remove(bucket: ImageBucket, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const { error } = await this.admin.storage.from(bucket).remove([...keys]);
    if (error) throw new Error(`Couldn't delete images from ${bucket}: ${error.message}`);
  }

  async exists(bucket: ImageBucket, key: string): Promise<boolean> {
    const { data, error } = await this.admin.storage.from(bucket).exists(key);
    // exists() reports a missing object as an error with data: false.
    if (error && data !== false) throw new Error(`Couldn't check an image in ${bucket}: ${error.message}`);
    return data === true;
  }

  async signedUrls(bucket: ImageBucket, keys: readonly string[], ttlSeconds: number): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const unique = [...new Set(keys)];
    if (unique.length === 0) return urls;
    const { data, error } = await this.admin.storage.from(bucket).createSignedUrls(unique, ttlSeconds);
    if (error) throw new Error(`Couldn't sign image URLs in ${bucket}: ${error.message}`);
    for (const entry of data) {
      if (entry.path && entry.signedUrl && !entry.error) urls.set(entry.path, entry.signedUrl);
    }
    return urls;
  }

  async listFolders(bucket: ImageBucket): Promise<string[]> {
    const entries = await this.listAll(bucket, "");
    // Folders come back with a null id.
    return entries.filter((e) => e.id === null).map((e) => e.name);
  }

  async listObjects(bucket: ImageBucket, folder: string): Promise<StoredObject[]> {
    const entries = await this.listAll(bucket, folder);
    return entries
      .filter((e) => e.id !== null && e.created_at)
      .map((e) => ({ key: `${folder}/${e.name}`, createdAt: new Date(e.created_at!) }));
  }

  private async listAll(bucket: ImageBucket, prefix: string) {
    const all: { name: string; id: string | null; created_at: string | null }[] = [];
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const { data, error } = await this.admin.storage
        .from(bucket)
        .list(prefix, { limit: LIST_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`Couldn't list images in ${bucket}: ${error.message}`);
      all.push(...data);
      if (data.length < LIST_PAGE_SIZE) return all;
    }
  }
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

/** For tests. Signed URLs are fake `memory://` links. */
export class InMemoryImageStorage implements ImageStorage {
  readonly objects = new Map<string, { image: ImageInput; createdAt: Date }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private id(bucket: ImageBucket, key: string): string {
    return `${bucket}/${key}`;
  }

  get(bucket: ImageBucket, key: string): ImageInput | undefined {
    return this.objects.get(this.id(bucket, key))?.image;
  }

  async upload(bucket: ImageBucket, key: string, image: ImageInput): Promise<void> {
    const id = this.id(bucket, key);
    if (this.objects.has(id)) throw new Error(`Couldn't store the image in ${bucket}: already exists`);
    this.objects.set(id, { image, createdAt: this.now() });
  }

  async remove(bucket: ImageBucket, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(this.id(bucket, key));
  }

  async exists(bucket: ImageBucket, key: string): Promise<boolean> {
    return this.objects.has(this.id(bucket, key));
  }

  async signedUrls(bucket: ImageBucket, keys: readonly string[], ttlSeconds: number): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (const key of keys) {
      if (this.objects.has(this.id(bucket, key))) urls.set(key, `memory://${bucket}/${key}?ttl=${ttlSeconds}`);
    }
    return urls;
  }

  async listFolders(bucket: ImageBucket): Promise<string[]> {
    const folders = new Set<string>();
    for (const id of this.objects.keys()) {
      const [b, folder] = id.split("/");
      if (b === bucket && folder) folders.add(folder);
    }
    return [...folders];
  }

  async listObjects(bucket: ImageBucket, folder: string): Promise<StoredObject[]> {
    const prefix = `${bucket}/${folder}/`;
    return [...this.objects.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, { createdAt }]) => ({ key: id.slice(bucket.length + 1), createdAt }));
  }
}
