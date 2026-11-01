/**
 * The order-email and settings routes, mock mode OFF: the inbound webhook
 * with a recorded Postmark payload (Basic auth from the webhook URL), the
 * processing it schedules after answering, GET /api/email-imports, and the
 * settings routes. In-memory stores, fake models, a local shop server; no
 * real network, Supabase or AI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, EmailImportListResponseSchema, UserSettingsSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { PUBLIC_V4, bytes, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";
import { tagging } from "@/test/fixtures/model-output";
import { NEXT_REPLY } from "@/test/fixtures/order-email";
import { phoneJpeg } from "@/test/images";
import { TEST_USER } from "@/test/ingestion-deps";

const fake = vi.hoisted(() => ({
  signedIn: true,
  tasks: [] as (() => unknown)[],
  email: null as unknown as ReturnType<typeof import("@/lib/email/test-support").makeEmailDeps>,
  settings: null as unknown as import("@/lib/settings/repository").InMemorySettingsRepository,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => fake.tasks.push(task),
}));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireUser: async () => {
      if (!fake.signedIn) throw new ApiException("unauthorized", "Sign in first");
      return { id: TEST_USER, email: "sam.tester@mail.example" };
    },
  };
});
vi.mock("@/lib/email/deps", () => ({
  getEmailProcessingDeps: () => fake.email.deps,
  getEmailImportReader: async () => fake.email.imports,
}));
vi.mock("@/lib/settings/deps", () => ({ getSettingsRepository: async () => fake.settings }));

import { basicAuthHeader } from "@/lib/email/postmark";
import { FORWARDING_CONFIG, TOKEN, emailFixture, makeEmailDeps } from "@/lib/email/test-support";
import { InMemorySettingsRepository } from "@/lib/settings/repository";
import * as emailImports from "./email-imports/route";
import * as inbound from "./inbound/email/route";
import * as forwardingAddress from "./settings/forwarding-address/route";
import * as settings from "./settings/route";

const BASE = "https://gladrags.example";
const SECRET = "b".repeat(64);
let server: TestServer;

function postmarkPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...(JSON.parse(emailFixture("postmark-inbound.json")) as Record<string, unknown>),
    HtmlBody: emailFixture("next-order.html").replaceAll("https://", "http://"),
    ...overrides,
  };
}

function webhook(body: unknown, authorization: string | null = basicAuthHeader("postmark", SECRET)): Request {
  return new Request(`${BASE}/api/inbound/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function runAfterTasks() {
  const tasks = fake.tasks.splice(0);
  for (const task of tasks) await task();
}

async function errorCode(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

beforeEach(async () => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("INBOUND_EMAIL_PROVIDER", "postmark");
  vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", FORWARDING_CONFIG.domain);
  vi.stubEnv("INBOUND_EMAIL_PREFIX", FORWARDING_CONFIG.prefix);
  fake.signedIn = true;
  fake.tasks = [];
  server = await startTestServer();
  const jpeg = (await phoneJpeg({ width: 900, height: 1200 })).data;
  server.routes.set("cdn.northgate.example/products/k98765-navy.jpg", bytes(jpeg, "image/jpeg"));
  server.routes.set("cdn.northgate.example/products/m22001-white.jpg", bytes(jpeg, "image/jpeg"));
  fake.email = makeEmailDeps(testNetwork(server.port, { "cdn.northgate.example": [PUBLIC_V4] }), {
    orderReplies: [NEXT_REPLY.replaceAll("https://", "http://")],
    taggerOutputs: [JSON.stringify(tagging.valid)],
  });
  fake.settings = new InMemorySettingsRepository();
  fake.settings.rows.set(TEST_USER, { favouriteShopIds: ["next", "marks_and_spencer", "new_look"], forwardingToken: TOKEN });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/inbound/email (Postmark)", () => {
  it("answers at once, then reads the order and adds its items 'to review'", async () => {
    const res = await inbound.POST(webhook(postmarkPayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // Nothing read yet: that happens after the answer.
    expect(fake.email.orderReader.calls).toHaveLength(0);
    expect(fake.tasks).toHaveLength(1);

    await runAfterTasks();
    const list = EmailImportListResponseSchema.parse(await (await emailImports.GET(new Request(`${BASE}/api/email-imports`))).json());
    expect(list.imports).toEqual([
      expect.objectContaining({ status: "done", shopName: "Northgate", orderDate: "2026-10-28", itemCount: 2, skippedCount: 0, error: null }),
    ]);
    expect([...fake.email.items.rows.values()].every((i) => i.source === "email" && i.needs_review)).toBe(true);
  });

  it("a redelivery from Postmark is answered and skipped", async () => {
    await inbound.POST(webhook(postmarkPayload()));
    await runAfterTasks();
    expect(await (await inbound.POST(webhook(postmarkPayload()))).json()).toEqual({ received: true });
    expect(fake.tasks).toHaveLength(0);
    expect(fake.email.orderReader.calls).toHaveLength(1);
  });

  it("refuses wrong or missing credentials with 401, before reading the email", async () => {
    expect(await errorCode(await inbound.POST(webhook(postmarkPayload(), basicAuthHeader("postmark", "c".repeat(64)))))).toBe("unauthorized");
    expect(await errorCode(await inbound.POST(webhook(postmarkPayload(), null)))).toBe("unauthorized");
    // Even a body that isn't JSON gets 401, not 400: nothing is parsed first.
    expect(await errorCode(await inbound.POST(webhook("not json", null)))).toBe("unauthorized");
    expect(fake.email.imports.rows.size).toBe(0);
  });

  it("refuses a malformed or oversized body (400) once the credentials check out", async () => {
    expect(await errorCode(await inbound.POST(webhook("not json")))).toBe("bad_request");
    expect(await errorCode(await inbound.POST(webhook(postmarkPayload({ FromFull: { Email: "not an address" } }))))).toBe("bad_request");
    const big = webhook(postmarkPayload({ TextBody: "x".repeat(2 * 1024 * 1024) }));
    expect(await errorCode(await inbound.POST(big))).toBe("bad_request");
  });

  it("an email to an unknown token is answered and leaves no trace", async () => {
    const to = `${FORWARDING_CONFIG.prefix}${"e".repeat(32)}@${FORWARDING_CONFIG.domain}`;
    const res = await inbound.POST(webhook(postmarkPayload({ ToFull: [{ Email: to }], OriginalRecipient: to })));
    expect(await res.json()).toEqual({ received: true });
    expect(fake.email.imports.rows.size).toBe(0);
    expect(fake.tasks).toHaveLength(0);
  });

  it("an email from someone else is recorded as failed, without its content", async () => {
    const res = await inbound.POST(webhook(postmarkPayload({ FromFull: { Email: "stranger@mail.example" } })));
    expect(await res.json()).toEqual({ received: true });
    expect(fake.tasks).toHaveLength(0);
    const list = EmailImportListResponseSchema.parse(await (await emailImports.GET(new Request(`${BASE}/api/email-imports`))).json());
    expect(list.imports).toEqual([expect.objectContaining({ status: "failed", error: "sender_not_allowed", shopName: null })]);
  });

  it("our own failure before answering is a 5xx, so Postmark retries", async () => {
    vi.spyOn(fake.email.imports, "findUserByToken").mockRejectedValueOnce(new Error("database down"));
    expect((await inbound.POST(webhook(postmarkPayload()))).status).toBe(500);
    expect((await inbound.POST(webhook(postmarkPayload()))).status).toBe(200);
  });

  it("refuses everything while the secret is the .env.example placeholder", async () => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "replace-me-with-at-least-32-random-characters");
    expect(await errorCode(await inbound.POST(webhook(postmarkPayload())))).toBe("server_misconfigured");
  });
});

describe("settings", () => {
  const get = () => settings.GET(new Request(`${BASE}/api/settings`));
  const put = (body: unknown) =>
    settings.PUT(new Request(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("GET shows the favourite shops and the forwarding address", async () => {
    expect(UserSettingsSchema.parse(await (await get()).json())).toEqual({
      favouriteShopIds: ["next", "marks_and_spencer", "new_look"],
      forwardingAddress: `${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`,
    });
  });

  it("the address is null while INBOUND_EMAIL_DOMAIN isn't set", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
    expect(UserSettingsSchema.parse(await (await get()).json()).forwardingAddress).toBeNull();
  });

  it("PUT changes the favourite shops; bad lists are refused", async () => {
    expect(UserSettingsSchema.parse(await (await put({ favouriteShopIds: ["zara", "uniqlo"] })).json()).favouriteShopIds).toEqual(["zara", "uniqlo"]);
    for (const body of [{ favouriteShopIds: [] }, { favouriteShopIds: ["zara", "zara"] }, { favouriteShopIds: ["primark"] }, {}]) {
      expect(await errorCode(await put(body))).toBe("bad_request");
    }
    expect(fake.settings.rows.get(TEST_USER)?.favouriteShopIds).toEqual(["zara", "uniqlo"]);
  });

  it("resetting gives a new address, and email to the old one is ignored", async () => {
    const res = await forwardingAddress.POST(new Request(`${BASE}/api/settings/forwarding-address`, { method: "POST" }));
    const after = UserSettingsSchema.parse(await res.json());
    expect(after.forwardingAddress).not.toContain(TOKEN);
    expect(after.forwardingAddress).toMatch(/^4f1c2a9be0d34e7a8b5c6d7e8f901234\+[0-9a-f]{32}@inbound\.postmark\.example$/);
    // The webhook's lookup follows the new token (the in-memory email store holds the old one only).
    fake.email.imports.tokens.clear();
    await inbound.POST(webhook(postmarkPayload()));
    expect(fake.email.imports.rows.size).toBe(0);
  });

  it("every settings route needs a signed-in user", async () => {
    fake.signedIn = false;
    expect(await errorCode(await get())).toBe("unauthorized");
    expect(await errorCode(await put({ favouriteShopIds: ["zara"] }))).toBe("unauthorized");
    expect(await errorCode(await forwardingAddress.POST(new Request(`${BASE}/api/settings/forwarding-address`, { method: "POST" })))).toBe("unauthorized");
    expect(await errorCode(await emailImports.GET(new Request(`${BASE}/api/email-imports`)))).toBe("unauthorized");
  });
});
