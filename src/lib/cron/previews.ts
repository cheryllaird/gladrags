/**
 * Round 2: the daily sweep of unused outfit previews (CONTRACTS.md
 * section 12, "When a picture goes"). Deletes outfit_previews rows that no
 * outfit shows or waits for, unchanged for PREVIEW_UNUSED_SWEEP_SECONDS
 * (failed looks kept for the retry window, an abandoned refresh, anything a
 * crash left), and returns their image keys so the job removes the files.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SweepUnusedPreviewsResultSchema } from "@/contracts";

export interface UnusedPreviewSweeper {
  sweep(olderThanSeconds: number): Promise<{ deleted: number; imageKeys: string[] }>;
}

/** Calls sweep_unused_outfit_previews (migration 8) with the secret key. */
export class SupabaseUnusedPreviewSweeper implements UnusedPreviewSweeper {
  constructor(private readonly admin: SupabaseClient) {}

  async sweep(olderThanSeconds: number): Promise<{ deleted: number; imageKeys: string[] }> {
    const { data, error } = await this.admin.rpc("sweep_unused_outfit_previews", { p_older_than_seconds: olderThanSeconds });
    if (error) throw new Error(`Couldn't sweep unused outfit previews: ${error.message}`);
    const result = SweepUnusedPreviewsResultSchema.parse(data);
    return { deleted: result.deleted, imageKeys: result.image_keys };
  }
}

/** For tests and mock mode. */
export class InMemoryUnusedPreviewSweeper implements UnusedPreviewSweeper {
  readonly calls: number[] = [];
  constructor(private readonly result: { deleted: number; imageKeys: string[] } = { deleted: 0, imageKeys: [] }) {}

  async sweep(olderThanSeconds: number): Promise<{ deleted: number; imageKeys: string[] }> {
    this.calls.push(olderThanSeconds);
    return this.result;
  }
}
