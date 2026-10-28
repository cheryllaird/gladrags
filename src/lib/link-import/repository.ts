/**
 * The link_imports table: one row per add-by-link step 1, waiting for
 * step 2 (CONTRACTS.md section 2). Server only: the table has RLS on with
 * no policies, so the Supabase version needs the admin (secret key)
 * client, and every query filters by the signed-in user's ID itself.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { LINK_IMPORT_TTL_SECONDS, LinkProductSchema, SourceUrlSchema, type LinkProduct } from "@/contracts";

export interface NewLinkImport {
  userId: string;
  sourceUrl: string;
  originalImageKey: string;
  product: LinkProduct;
}

/** What step 2 gets back: the server's own copy of what step 1 read. */
export interface OpenLinkImport {
  sourceUrl: string;
  product: LinkProduct;
}

export interface LinkImportRepository {
  create(entry: NewLinkImport): Promise<void>;
  /**
   * Read-only: the import, if it's this user's, unused and inside its time
   * limit. Lets step 2 check the cut-out before using the import up.
   */
  findOpen(userId: string, originalImageKey: string): Promise<OpenLinkImport | null>;
  /**
   * Use the import up, in one statement, so it can only happen once. Null
   * if it isn't this user's, was already used, or has expired.
   */
  claim(userId: string, originalImageKey: string): Promise<OpenLinkImport | null>;
  /**
   * Undo a claim (tagged_at back to null) when step 2 stopped before
   * tagging, e.g. because AI paused. The import's time limit still applies.
   */
  release(userId: string, originalImageKey: string): Promise<void>;
  /** Delete rows older than the cutoff (used or not). Returns how many went. */
  deleteCreatedBefore(cutoff: Date): Promise<number>;
}

const OpenRowSchema = z.object({ source_url: SourceUrlSchema, product: LinkProductSchema });

function toOpen(data: unknown): OpenLinkImport | null {
  if (!data) return null;
  const row = OpenRowSchema.parse(data);
  return { sourceUrl: row.source_url, product: row.product };
}

function ttlCutoff(now: Date): string {
  return new Date(now.getTime() - LINK_IMPORT_TTL_SECONDS * 1000).toISOString();
}

export class SupabaseLinkImportRepository implements LinkImportRepository {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(entry: NewLinkImport): Promise<void> {
    const { error } = await this.admin.from("link_imports").insert({
      user_id: entry.userId,
      source_url: entry.sourceUrl,
      original_image_key: entry.originalImageKey,
      product: entry.product,
    });
    if (error) throw new Error(`Couldn't record the link import: ${error.message}`);
  }

  async findOpen(userId: string, originalImageKey: string): Promise<OpenLinkImport | null> {
    const { data, error } = await this.admin
      .from("link_imports")
      .select("source_url, product")
      .eq("user_id", userId)
      .eq("original_image_key", originalImageKey)
      .is("tagged_at", null)
      .gt("created_at", ttlCutoff(this.now()))
      .maybeSingle();
    if (error) throw new Error(`Couldn't read the link import: ${error.message}`);
    return toOpen(data);
  }

  async claim(userId: string, originalImageKey: string): Promise<OpenLinkImport | null> {
    // One UPDATE ... WHERE tagged_at IS NULL ... RETURNING. Two requests at
    // once: the second waits on the row lock, re-checks tagged_at, and
    // matches nothing.
    const now = this.now();
    const { data, error } = await this.admin
      .from("link_imports")
      .update({ tagged_at: now.toISOString() })
      .eq("user_id", userId)
      .eq("original_image_key", originalImageKey)
      .is("tagged_at", null)
      .gt("created_at", ttlCutoff(now))
      .select("source_url, product")
      .maybeSingle();
    if (error) throw new Error(`Couldn't claim the link import: ${error.message}`);
    return toOpen(data);
  }

  async release(userId: string, originalImageKey: string): Promise<void> {
    const { error } = await this.admin
      .from("link_imports")
      .update({ tagged_at: null })
      .eq("user_id", userId)
      .eq("original_image_key", originalImageKey);
    if (error) throw new Error(`Couldn't release the link import: ${error.message}`);
  }

  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const { data, error } = await this.admin.from("link_imports").delete().lt("created_at", cutoff.toISOString()).select("id");
    if (error) throw new Error(`Couldn't delete old link imports: ${error.message}`);
    return (data ?? []).length;
  }

}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

interface MemoryRow extends NewLinkImport {
  createdAt: Date;
  taggedAt: Date | null;
}

/** For tests. Same rules as the SQL: owner, unused, inside the time limit. */
export class InMemoryLinkImportRepository implements LinkImportRepository {
  readonly rows = new Map<string, MemoryRow>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(entry: NewLinkImport): Promise<void> {
    if (this.rows.has(entry.originalImageKey)) throw new Error("Couldn't record the link import: duplicate key");
    if (!entry.originalImageKey.startsWith(`${entry.userId}/`)) throw new Error("Couldn't record the link import: image not in owner folder");
    this.rows.set(entry.originalImageKey, { ...structuredClone(entry), createdAt: this.now(), taggedAt: null });
  }

  private open(userId: string, key: string): MemoryRow | null {
    const row = this.rows.get(key);
    if (!row || row.userId !== userId || row.taggedAt) return null;
    if (row.createdAt.getTime() <= this.now().getTime() - LINK_IMPORT_TTL_SECONDS * 1000) return null;
    return row;
  }

  async findOpen(userId: string, key: string): Promise<OpenLinkImport | null> {
    const row = this.open(userId, key);
    return row ? { sourceUrl: row.sourceUrl, product: structuredClone(row.product) } : null;
  }

  async claim(userId: string, key: string): Promise<OpenLinkImport | null> {
    const row = this.open(userId, key);
    if (!row) return null;
    row.taggedAt = this.now();
    return { sourceUrl: row.sourceUrl, product: structuredClone(row.product) };
  }

  async release(userId: string, key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row && row.userId === userId) row.taggedAt = null;
  }

  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (row.createdAt < cutoff) {
        this.rows.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  /** Keys an unfinished import can still use (for the image cleanup tests). */
  openKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [key, row] of this.rows) if (this.open(row.userId, key)) keys.add(key);
    return keys;
  }
}
