/**
 * GET /api/cron/cleanup: refuses without the right bearer secret (500 if
 * none is configured), runs both cleanup jobs plus the sign-in attempt
 * purge, and reports counts only. Runs against in-memory stores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, CronCleanupResponseSchema, STORAGE_BUCKETS } from "@/contracts";
import { InMemorySignInAttemptStore, hashEmail } from "@/lib/auth/rate-limit";
import type { CleanupJobDeps } from "@/lib/cron/cleanup";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage, newImageKey } from "@/lib/ingestion/storage";
import { InMemoryLinkImportRepository } from "@/lib/link-import/repository";

const USER = "0c000000-0000-4000-8000-000000000003";
const SECRET = "test-cron-secret-0123456789abcdef";

const state = vi.hoisted(() => ({ deps: null as unknown as CleanupJobDeps }));
vi.mock("@/lib/cron/deps", () => ({ getCleanupJobDeps: () => state.deps }));

import { GET } from "./route";

let now = new Date("2026-10-26T03:17:00Z");
const clock = () => now;

function call(headers: Record<string, string> = {}) {
  return GET(new Request("http://localhost/api/cron/cleanup", { headers }));
}

async function errorCode(response: Response) {
  return ApiErrorSchema.parse(await response.json()).error.code;
}

beforeEach(() => {
  now = new Date("2026-10-26T03:17:00Z");
  state.deps = {
    storage: new InMemoryImageStorage(clock),
    references: new InMemoryItemRepository(clock),
    linkImports: new InMemoryLinkImportRepository(clock),
    signInAttempts: new InMemorySignInAttemptStore(clock),
    now: clock,
  };
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("authorisation", () => {
  it.each([
    ["no header", {}],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }],
    ["the secret without Bearer", { authorization: SECRET }],
    ["the right secret with a different scheme", { authorization: `Basic ${SECRET}` }],
    ["a prefix of the secret", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["the secret plus extra", { authorization: `Bearer ${SECRET}x` }],
  ])("refuses %s with 401 and runs nothing", async (_label, headers) => {
    const remove = vi.spyOn(state.deps.storage, "remove");
    const response = await call(headers);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthorized");
    expect(remove).not.toHaveBeenCalled();
  });

  it("answers 500 server_misconfigured when CRON_SECRET isn't set, even to 'Bearer '", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer " }, { authorization: "Bearer undefined" }];
    for (const headers of attempts) {
      const response = await call(headers);
      expect(response.status).toBe(500);
      expect(await errorCode(response)).toBe("server_misconfigured");
    }
  });
});

describe("the cleanup", () => {
  it("deletes orphaned images, old link imports and old sign-in attempts, and returns counts only", async () => {
    const image = { data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" as const };
    // Two days ago: an orphan, and one a saved item still uses.
    now = new Date("2026-10-24T03:00:00Z");
    const orphan = newImageKey(USER, "image/jpeg");
    const used = newImageKey(USER, "image/jpeg");
    await state.deps.storage.upload(STORAGE_BUCKETS.originals, orphan, image);
    await state.deps.storage.upload(STORAGE_BUCKETS.originals, used, image);
    await (state.deps.references as InMemoryItemRepository).create(USER, {
      source: "photo",
      sourceUrl: null,
      originalImageKey: used,
      cutoutImageKey: null,
      tags: {
        category: "top",
        subcategory: "shirt",
        colours: ["white"],
        pattern: "plain",
        formality: 3,
        seasons: ["spring"],
        warmth: "light",
        occasions: ["work"],
        fabric: null,
        description: "White shirt",
      },
      tagsEdited: false,
    });
    await state.deps.signInAttempts.reserve("magic_link", hashEmail("old@example.com"), null, { perEmail: 5, perIp: 20, windowSeconds: 900 });
    // Eight days ago: a link import row.
    now = new Date("2026-10-18T03:00:00Z");
    await state.deps.linkImports.create({
      userId: USER,
      sourceUrl: "https://shop.example/p",
      originalImageKey: newImageKey(USER, "image/jpeg"),
      product: { title: "", brand: "", colour: "" },
    });
    // Today: a fresh sign-in attempt that must stay.
    now = new Date("2026-10-26T03:17:00Z");
    await state.deps.signInAttempts.reserve("magic_link", hashEmail("new@example.com"), null, { perEmail: 5, perIp: 20, windowSeconds: 900 });

    const response = await call({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    const body = CronCleanupResponseSchema.strict().parse(await response.json());
    expect(body).toEqual({ imagesChecked: 2, orphanedImagesDeleted: 1, linkImportsDeleted: 1, signInAttemptsDeleted: 1 });

    expect(await state.deps.storage.exists(STORAGE_BUCKETS.originals, orphan)).toBe(false);
    expect(await state.deps.storage.exists(STORAGE_BUCKETS.originals, used)).toBe(true);
    expect((state.deps.signInAttempts as InMemorySignInAttemptStore).attempts).toHaveLength(1);
    // Nothing identifying in the response or the log.
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const text of [JSON.stringify(body), logged]) {
      expect(text).not.toContain(USER);
      expect(text).not.toContain("example.com");
    }
  });

  it("an empty run reports zeros", async () => {
    const response = await call({ authorization: `Bearer ${SECRET}` });
    expect(await response.json()).toEqual({ imagesChecked: 0, orphanedImagesDeleted: 0, linkImportsDeleted: 0, signInAttemptsDeleted: 0 });
  });
});
