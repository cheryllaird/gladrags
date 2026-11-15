/**
 * QA (round 2, P1): the model preset in settings, mock mode OFF, with an
 * in-memory repository holding two users: a user can't read or change
 * another user's preset, can't clear theirs, and a preset-only change
 * leaves the shops alone. Also what SupabaseSettingsRepository sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, UserSettingsSchema } from "@/contracts";
import { TEST_USER } from "@/test/ingestion-deps";

const OTHER_USER = "0b000000-0000-4000-8000-0000000000b2";

const fake = vi.hoisted(() => ({
  userId: "",
  settings: null as unknown as import("@/lib/settings/repository").InMemorySettingsRepository,
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireUser: async () => ({ id: fake.userId, email: "sam.tester@mail.example" }) };
});
vi.mock("@/lib/settings/deps", () => ({ getSettingsRepository: async () => fake.settings }));

import { InMemorySettingsRepository, SupabaseSettingsRepository } from "@/lib/settings/repository";
import * as settings from "./settings/route";

const BASE = "https://gladrags.example";

function put(body: unknown): Request {
  return new Request(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
  fake.userId = TEST_USER;
  fake.settings = new InMemorySettingsRepository();
  fake.settings.rows.set(TEST_USER, { favouriteShopIds: ["next"], forwardingToken: "a".repeat(32) });
  fake.settings.rows.set(OTHER_USER, { favouriteShopIds: ["zara"], forwardingToken: "b".repeat(32), modelPresetId: "men_broad_deep" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("QA: settings with a model preset (real route, in-memory rows)", () => {
  it("a row saved before round 2 (no preset field) reads as null", async () => {
    const body = UserSettingsSchema.parse(await (await settings.GET(new Request(`${BASE}/api/settings`))).json());
    expect(body.modelPresetId).toBeNull();
  });

  it("picking a preset changes only the caller's row, and leaves their shops alone", async () => {
    const res = await settings.PUT(put({ modelPresetId: "women_curvy_deep" }));
    expect(res.status).toBe(200);
    expect(UserSettingsSchema.parse(await res.json())).toMatchObject({ modelPresetId: "women_curvy_deep", favouriteShopIds: ["next"] });
    expect(fake.settings.rows.get(OTHER_USER)).toMatchObject({ modelPresetId: "men_broad_deep", favouriteShopIds: ["zara"] });
  });

  it("a body naming another user changes the caller's own row only", async () => {
    await settings.PUT(put({ modelPresetId: "men_slim_light", userId: OTHER_USER, user_id: OTHER_USER }));
    expect(fake.settings.rows.get(TEST_USER)?.modelPresetId).toBe("men_slim_light");
    expect(fake.settings.rows.get(OTHER_USER)?.modelPresetId).toBe("men_broad_deep");
  });

  it("the other user sees their own preset, never the caller's", async () => {
    await settings.PUT(put({ modelPresetId: "men_slim_light" }));
    fake.userId = OTHER_USER;
    const body = UserSettingsSchema.parse(await (await settings.GET(new Request(`${BASE}/api/settings`))).json());
    expect(body).toMatchObject({ modelPresetId: "men_broad_deep", favouriteShopIds: ["zara"] });
  });

  it.each([
    ["unknown", { modelPresetId: "robot" }],
    ["cleared (null)", { modelPresetId: null }],
    ["cleared (empty)", { modelPresetId: "" }],
    ["a number", { modelPresetId: 3 }],
    ["neither field", { forwardingToken: "c".repeat(32) }],
  ])("refuses a %s preset with bad_request and changes nothing", async (_label, body) => {
    fake.settings.rows.get(TEST_USER)!.modelPresetId = "women_slim_light";
    const res = await settings.PUT(put(body));
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("bad_request");
    expect(fake.settings.rows.get(TEST_USER)).toMatchObject({ modelPresetId: "women_slim_light", forwardingToken: "a".repeat(32) });
  });

  it("refuses a body that isn't JSON", async () => {
    const res = await settings.PUT(put("modelPresetId=women_slim_light"));
    expect(res.status).toBe(400);
  });
});

describe("QA: SupabaseSettingsRepository.update", () => {
  /** A stand-in for the query builder that records the update and filter. */
  function recordingClient(row: Record<string, unknown>) {
    const calls: { table?: string; update?: Record<string, unknown>; eq?: [string, unknown] } = {};
    const builder = {
      update(columns: Record<string, unknown>) {
        calls.update = columns;
        return builder;
      },
      eq(column: string, value: unknown) {
        calls.eq = [column, value];
        return builder;
      },
      select() {
        return builder;
      },
      maybeSingle: async () => ({ data: row, error: null }),
    };
    const client = {
      from(table: string) {
        calls.table = table;
        return builder;
      },
    };
    return { client, calls };
  }

  const stored = { favourite_shop_ids: ["next"], forwarding_token: "a".repeat(32), model_preset_id: "women_plus_light" };

  it("a preset-only change writes model_preset_id alone, filtered to the caller", async () => {
    const { client, calls } = recordingClient(stored);
    const repo = new SupabaseSettingsRepository(client as never);
    expect(await repo.update(TEST_USER, { modelPresetId: "women_plus_light" })).toMatchObject({ modelPresetId: "women_plus_light" });
    expect(calls).toEqual({ table: "user_settings", update: { model_preset_id: "women_plus_light" }, eq: ["user_id", TEST_USER] });
  });

  it("a shops-only change doesn't touch the preset", async () => {
    const { client, calls } = recordingClient(stored);
    await new SupabaseSettingsRepository(client as never).update(TEST_USER, { favouriteShopIds: ["zara"] });
    expect(calls.update).toEqual({ favourite_shop_ids: ["zara"] });
  });

  // Changed by the orchestrator (QA finding on P4): a row whose stored preset
  // isn't on the list used to fail the read (and with it GET /api/settings).
  // It now reads as null, "not picked yet", and the rest of the row is kept.
  it("reads a row whose stored preset isn't on the list as no preset, keeping the rest", async () => {
    const { client } = recordingClient({ ...stored, model_preset_id: "retired_preset" });
    const row = await new SupabaseSettingsRepository(client as never).get(TEST_USER);
    expect(row).not.toBeNull();
    expect(row!.modelPresetId).toBeNull();
    expect(row!.favouriteShopIds).toEqual(stored.favourite_shop_ids);
  });
});
