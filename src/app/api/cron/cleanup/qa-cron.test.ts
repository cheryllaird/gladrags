/**
 * QA (fix/hardening): GET /api/cron/cleanup. Header and secret edge cases,
 * the constant-time compare, and what the job must NOT delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, CronCleanupResponseSchema, STORAGE_BUCKETS, type ItemTags } from "@/contracts";
import { InMemorySignInAttemptStore, hashEmail } from "@/lib/auth/rate-limit";
import type { CleanupJobDeps } from "@/lib/cron/cleanup";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage, newImageKey } from "@/lib/ingestion/storage";
import { InMemoryLinkImportRepository } from "@/lib/link-import/repository";

const USER = "0c000000-0000-4000-8000-000000000003";
const OTHER = "0b000000-0000-4000-8000-000000000002";
const SECRET = "Qa-Cron-Secret-0123456789abcdef0123456789";

const state = vi.hoisted(() => ({
  deps: null as unknown as CleanupJobDeps,
  depsBuilt: 0,
  compares: [] as [number, number][],
}));
vi.mock("@/lib/cron/deps", () => ({
  getCleanupJobDeps: () => {
    state.depsBuilt++;
    return state.deps;
  },
}));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      state.compares.push([a.byteLength, b.byteLength]);
      return original.timingSafeEqual(a, b);
    },
  };
});

import * as route from "./route";

let now = new Date("2026-10-26T03:17:00Z");
const clock = () => now;
const TAGS: ItemTags = {
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
};
const IMAGE = { data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" as const };

function call(headers: Record<string, string> = {}) {
  return route.GET(new Request("http://localhost/api/cron/cleanup", { headers }));
}

const items = () => state.deps.references as InMemoryItemRepository;
const at = async <T>(iso: string, fn: () => Promise<T>) => {
  const saved = now;
  now = new Date(iso);
  try {
    return await fn();
  } finally {
    now = saved;
  }
};

beforeEach(() => {
  now = new Date("2026-10-26T03:17:00Z");
  state.deps = {
    storage: new InMemoryImageStorage(clock),
    references: new InMemoryItemRepository(clock),
    linkImports: new InMemoryLinkImportRepository(clock),
    signInAttempts: new InMemorySignInAttemptStore(clock),
    now: clock,
  };
  state.depsBuilt = 0;
  state.compares = [];
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the secret", () => {
  it.each([
    ["lower-case scheme", `bearer ${SECRET}`],
    ["upper-case scheme", `BEARER ${SECRET}`],
    ["the secret in a different case", `Bearer ${SECRET.toLowerCase()}`],
    ["two spaces after Bearer", `Bearer  ${SECRET}`],
    ["a tab after Bearer", `Bearer\t${SECRET}`],
    ["the secret twice", `Bearer ${SECRET}, Bearer ${SECRET}`],
    ["a 64 KB header", `Bearer ${"x".repeat(65_536)}`],
    ["one character", "x"],
    ["Bearer only", "Bearer"],
  ])("%s: 401, deps never built", async (_label, authorization) => {
    const res = await call({ authorization });
    expect(res.status).toBe(401);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("unauthorized");
    expect(state.depsBuilt).toBe(0);
  });

  it("surrounding whitespace is trimmed by the Headers API itself, so it's the same header (200)", async () => {
    expect((await call({ authorization: `  Bearer ${SECRET}  ` })).status).toBe(200);
  });

  it("the comparison is always between two equal-length digests, whatever the header length", async () => {
    for (const authorization of ["", "x", `Bearer ${SECRET}`, `Bearer ${"y".repeat(10_000)}`]) await call(authorization ? { authorization } : {});
    expect(state.compares.length).toBeGreaterThanOrEqual(4);
    for (const [a, b] of state.compares) {
      expect(a).toBe(32);
      expect(b).toBe(32);
    }
  });

  it("CRON_SECRET unset: 500 server_misconfigured for any header, deps never built", async () => {
    vi.stubEnv("CRON_SECRET", undefined as unknown as string);
    delete process.env.CRON_SECRET;
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer " }, { authorization: "Bearer undefined" }, { authorization: `Bearer ${SECRET}` }];
    for (const headers of attempts) {
      const res = await call(headers);
      expect(res.status).toBe(500);
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("server_misconfigured");
    }
    expect(state.depsBuilt).toBe(0);
  });

  // Was NOTE (low), fixed: a CRON_SECRET no header can match (only
  // whitespace, or whitespace around it, since header values are trimmed)
  // used to 401 every night silently. It's now reported as misconfigured.
  it.each([["only spaces", "   "], ["a trailing newline", `${SECRET}\n`], ["a leading space", ` ${SECRET}`], ["a tab", "\t"]])(
    "a CRON_SECRET with %s is misconfigured (500) for any header",
    async (_label, secret) => {
      vi.stubEnv("CRON_SECRET", secret);
      for (const header of ["Bearer    ", `Bearer ${SECRET}`, `Bearer ${secret}`]) {
        const res = await call({ authorization: header });
        expect(res.status).toBe(500);
        expect((await res.json()).error.code).toBe("server_misconfigured");
      }
    },
  );

  it("only GET is exported: POST, PUT, PATCH and DELETE get Next's 405", () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["GET"]);
  });
});

describe("what the job keeps", () => {
  it("keeps every image an item uses (originals and cut-outs, any user), recent images, recent rows; deletes only true orphans", async () => {
    const keys = {
      usedOriginal: newImageKey(USER, "image/jpeg"),
      usedCutout: newImageKey(USER, "image/png"),
      otherUsersOriginal: newImageKey(OTHER, "image/jpeg"),
      recentOrphan: newImageKey(USER, "image/jpeg"),
      oldOrphan: newImageKey(USER, "image/jpeg"),
      oldOrphanCutout: newImageKey(USER, "image/png"),
      openImport: newImageKey(USER, "image/jpeg"),
    };
    await at("2026-10-20T10:00:00Z", async () => {
      await state.deps.storage.upload(STORAGE_BUCKETS.originals, keys.usedOriginal, IMAGE);
      await state.deps.storage.upload(STORAGE_BUCKETS.cutouts, keys.usedCutout, IMAGE);
      await state.deps.storage.upload(STORAGE_BUCKETS.originals, keys.otherUsersOriginal, IMAGE);
      await state.deps.storage.upload(STORAGE_BUCKETS.originals, keys.oldOrphan, IMAGE);
      await state.deps.storage.upload(STORAGE_BUCKETS.cutouts, keys.oldOrphanCutout, IMAGE);
      await items().create(USER, { source: "photo", sourceUrl: null, originalImageKey: keys.usedOriginal, cutoutImageKey: keys.usedCutout, tags: TAGS, tagsEdited: false });
      await items().create(OTHER, { source: "photo", sourceUrl: null, originalImageKey: keys.otherUsersOriginal, cutoutImageKey: null, tags: TAGS, tagsEdited: false });
    });
    // 23 h 59 min old: a draft that might still be saved.
    await at("2026-10-25T03:18:00Z", () => state.deps.storage.upload(STORAGE_BUCKETS.originals, keys.recentOrphan, IMAGE));
    // An add-by-link import opened 10 minutes ago.
    await at("2026-10-26T03:07:00Z", async () => {
      await state.deps.storage.upload(STORAGE_BUCKETS.originals, keys.openImport, IMAGE);
      await state.deps.linkImports.create({ userId: USER, sourceUrl: "https://shop.example/p", originalImageKey: keys.openImport, product: { title: "", brand: "", colour: "" } });
      items().openLinkImportKeys.add(keys.openImport);
    });
    // Link import rows: 6 days 23 h (kept) and 7 days 1 h (deleted).
    await at("2026-10-19T04:17:00Z", () =>
      state.deps.linkImports.create({ userId: USER, sourceUrl: "https://shop.example/a", originalImageKey: newImageKey(USER, "image/jpeg"), product: { title: "", brand: "", colour: "" } }),
    );
    await at("2026-10-19T02:17:00Z", () =>
      state.deps.linkImports.create({ userId: USER, sourceUrl: "https://shop.example/b", originalImageKey: newImageKey(USER, "image/jpeg"), product: { title: "", brand: "", colour: "" } }),
    );
    // Sign-in attempts: 10 min ago (inside the rate-limit window), 23 h ago, and 25 h ago.
    const limits = { perEmail: 5, perIp: 20, windowSeconds: 900 };
    await at("2026-10-26T03:07:00Z", () => state.deps.signInAttempts.reserve("verify_code", hashEmail("a@example.com"), null, limits));
    await at("2026-10-25T04:17:00Z", () => state.deps.signInAttempts.reserve("magic_link", hashEmail("b@example.com"), null, limits));
    await at("2026-10-25T02:17:00Z", () => state.deps.signInAttempts.reserve("magic_link", hashEmail("c@example.com"), null, limits));

    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = CronCleanupResponseSchema.strict().parse(await res.json());
    expect(body).toEqual({ imagesChecked: 5, orphanedImagesDeleted: 2, linkImportsDeleted: 1, signInAttemptsDeleted: 1 });

    const exists = (bucket: "originals" | "cutouts", key: string) => state.deps.storage.exists(STORAGE_BUCKETS[bucket], key);
    expect(await exists("originals", keys.usedOriginal)).toBe(true);
    expect(await exists("cutouts", keys.usedCutout)).toBe(true);
    expect(await exists("originals", keys.otherUsersOriginal)).toBe(true);
    expect(await exists("originals", keys.recentOrphan)).toBe(true);
    expect(await exists("originals", keys.openImport)).toBe(true);
    expect(await exists("originals", keys.oldOrphan)).toBe(false);
    expect(await exists("cutouts", keys.oldOrphanCutout)).toBe(false);
    expect(await state.deps.linkImports.findOpen(USER, keys.openImport)).not.toBeNull();
    expect((state.deps.signInAttempts as InMemorySignInAttemptStore).attempts).toHaveLength(2);
  });

  it("a recent sign-in attempt that's still limiting someone survives the cleanup", async () => {
    const limits = { perEmail: 5, perIp: 20, windowSeconds: 900 };
    for (let i = 0; i < 5; i++) await state.deps.signInAttempts.reserve("verify_code", hashEmail("a@example.com"), null, limits);
    await call({ authorization: `Bearer ${SECRET}` });
    expect(await state.deps.signInAttempts.reserve("verify_code", hashEmail("a@example.com"), null, limits)).toMatchObject({ ok: false });
  });

  it("if checking references fails, nothing is deleted and the job answers 500 without detail", async () => {
    await at("2026-10-20T10:00:00Z", () => state.deps.storage.upload(STORAGE_BUCKETS.originals, newImageKey(USER, "image/jpeg"), IMAGE));
    vi.spyOn(items(), "referenced").mockRejectedValue(new Error(`Couldn't check image references: ${USER} db down`));
    const remove = vi.spyOn(state.deps.storage, "remove");
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(USER);
    expect(text).not.toContain("db down");
    expect(remove).not.toHaveBeenCalled();
  });
});
