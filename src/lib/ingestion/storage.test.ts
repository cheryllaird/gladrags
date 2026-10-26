/**
 * SupabaseImageStorage.upload: what it asks Supabase Storage to store,
 * against a hand-made client (no network).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { IMAGE_CACHE_CONTROL, SupabaseImageStorage } from "./storage";

function fakeAdmin() {
  const uploads: { bucket: string; key: string; options: Record<string, unknown> }[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string, _data: Uint8Array, options: Record<string, unknown>) => {
          uploads.push({ bucket, key, options });
          return { data: { path: key }, error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, uploads };
}

describe("SupabaseImageStorage.upload", () => {
  it("stores images as private and short-lived for caches, never overwriting", async () => {
    const { client, uploads } = fakeAdmin();
    await new SupabaseImageStorage(client).upload("cutouts", "u/k.png", { data: new Uint8Array([1]), mimeType: "image/png" });
    expect(IMAGE_CACHE_CONTROL).toBe("private, max-age=600");
    expect(uploads).toEqual([
      {
        bucket: "cutouts",
        key: "u/k.png",
        options: { contentType: "image/png", upsert: false, cacheControl: "600", headers: { "cache-control": "private, max-age=600" } },
      },
    ]);
  });
});
