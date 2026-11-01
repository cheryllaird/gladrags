/**
 * QA (milestone 5, C3): the order-email webhook, settings and email-imports
 * routes with mock mode OFF, attacked from outside. A recorded Postmark
 * payload, recorded model replies, in-memory stores and a local shop
 * server behind a fake DNS. No real network, Supabase or AI.
 *
 * Known bugs are pinned with `it.fails` and named "BUG:".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, EmailImportListResponseSchema, SHOPS, UserSettingsSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { PUBLIC_V4, bytes, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";
import { tagging } from "@/test/fixtures/model-output";
import { NEXT_REPLY } from "@/test/fixtures/order-email";
import { phoneJpeg } from "@/test/images";
import { TEST_USER } from "@/test/ingestion-deps";

const OTHER_USER = "8a7f0c1e-0000-4000-8000-0000000000b2";

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
import { messageHash } from "@/lib/email/receive";
import { SupabaseEmailImportReader, SupabaseEmailImportRepository } from "@/lib/email/repository";
import { EMAIL_TEST_LIMITS, FORWARDING_CONFIG, TOKEN, USER_EMAIL, emailFixture, makeEmailDeps } from "@/lib/email/test-support";
import { InMemorySettingsRepository } from "@/lib/settings/repository";
import * as emailImports from "./email-imports/route";
import * as inbound from "./inbound/email/route";
import * as forwardingAddress from "./settings/forwarding-address/route";
import * as settings from "./settings/route";

const BASE = "https://gladrags.example";
const SECRET = "b".repeat(64);
const TWO_MB = 2 * 1024 * 1024;
let server: TestServer;

type Header = { Name: string; Value: string };

function postmarkPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...(JSON.parse(emailFixture("postmark-inbound.json")) as Record<string, unknown>),
    HtmlBody: emailFixture("next-order.html").replaceAll("https://", "http://"),
    ...overrides,
  };
}
const fixtureHeaders = () => (JSON.parse(emailFixture("postmark-inbound.json")) as { Headers: Header[] }).Headers;

function webhook(body: BodyInit | object, { authorization = basicAuthHeader("postmark", SECRET) as string | null, headers = {} as Record<string, string> } = {}): Request {
  const isRaw = typeof body === "string" || body instanceof ReadableStream || body instanceof Uint8Array;
  return new Request(`${BASE}/api/inbound/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...headers },
    body: isRaw ? (body as BodyInit) : JSON.stringify(body),
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function runAfterTasks() {
  const tasks = fake.tasks.splice(0);
  for (const task of tasks) await task();
}

async function errorCode(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

async function listImports() {
  return EmailImportListResponseSchema.parse(await (await emailImports.GET(new Request(`${BASE}/api/email-imports`))).json()).imports;
}

/** Nothing was recorded or scheduled, and the model never ran. */
function expectNoTrace() {
  expect(fake.email.imports.rows.size).toBe(0);
  expect(fake.tasks).toHaveLength(0);
  expect(fake.email.orderReader.calls).toHaveLength(0);
}

beforeEach(async () => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("INBOUND_EMAIL_PROVIDER", "postmark");
  vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", FORWARDING_CONFIG.domain);
  vi.stubEnv("INBOUND_EMAIL_PREFIX", FORWARDING_CONFIG.prefix);
  vi.stubEnv("INBOUND_EMAIL_AUTHSERV_ID", "");
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
  // The webhook's token lookup reads the same settings the reset route changes.
  fake.email.imports.findUserByToken = async (token) => {
    for (const [userId, row] of fake.settings.rows) if (row.forwardingToken === token) return { userId, email: userId === TEST_USER ? USER_EMAIL : "other@mail.example" };
    return null;
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("webhook authentication", () => {
  it.each([
    ["no Authorization header", null],
    ["a wrong password", basicAuthHeader("postmark", "c".repeat(64))],
    ["the .env.example placeholder as the password", basicAuthHeader("postmark", "replace-me-with-at-least-32-random-characters")],
    ["the secret as the user name", `Basic ${Buffer.from(`${SECRET}:x`).toString("base64")}`],
    ["a Bearer token", `Bearer ${SECRET}`],
    ["a Digest header", `Digest username="postmark", response="${SECRET}"`],
    ["the secret in plain text", `Basic postmark:${SECRET}`],
    ["Basic with garbage", "Basic %%%%"],
  ])("%s: 401, nothing parsed or recorded", async (_label, authorization) => {
    const res = await inbound.POST(webhook(postmarkPayload(), { authorization }));
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
    expectNoTrace();
  });

  it("credentials are checked before the body is parsed: junk with a wrong password is 401, not 400", async () => {
    for (const body of ["{", "", "\u0000\u0001", "null"]) {
      expect(await errorCode(await inbound.POST(webhook(body, { authorization: basicAuthHeader("p", "nope") })))).toBe("unauthorized");
    }
    expectNoTrace();
  });

  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["31 characters", "x".repeat(31)],
    ["the .env.example placeholder", "replace-me-with-at-least-32-random-characters"],
    ["a placeholder variant", "replace-me-and-make-it-long-enough-to-pass-length"],
  ])("a secret that is %s: 500 server_misconfigured for every request, even one carrying that secret", async (_label, secret) => {
    if (secret === undefined) vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", undefined as unknown as string);
    else vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", secret);
    for (const authorization of [null, basicAuthHeader("postmark", secret ?? ""), basicAuthHeader("postmark", SECRET)]) {
      const res = await inbound.POST(webhook(postmarkPayload(), { authorization }));
      expect(res.status).toBe(500);
      expect(await errorCode(res)).toBe("server_misconfigured");
    }
    expectNoTrace();
  });

  it.each([["missing", ""], ["unknown", "sendgrid"]])("a provider that is %s: 500 server_misconfigured", async (_label, provider) => {
    vi.stubEnv("INBOUND_EMAIL_PROVIDER", provider);
    expect(await errorCode(await inbound.POST(webhook(postmarkPayload())))).toBe("server_misconfigured");
    expectNoTrace();
  });

  it("the error never echoes the secret or the credentials sent", async () => {
    const res = await inbound.POST(webhook(postmarkPayload(), { authorization: basicAuthHeader("postmark", "guess-guess-guess-guess-guess-guess") }));
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("guess-guess");
  });

  it("a GET isn't a webhook", async () => {
    expect("GET" in inbound).toBe(false);
  });
});

describe("webhook body", () => {
  it("an over-limit Content-Length is refused without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 4) controller.close();
      },
    });
    const res = await inbound.POST(webhook(stream, { headers: { "content-length": String(TWO_MB + 1) } }));
    expect(await errorCode(res)).toBe("bad_request");
    // At most the stream's own read-ahead; the body wasn't consumed.
    expect(pulled).toBeLessThanOrEqual(2);
    expectNoTrace();
  });

  it("a lying Content-Length (small) over a big body is cut off at the limit", async () => {
    const big = JSON.stringify(postmarkPayload({ TextBody: "x".repeat(TWO_MB) }));
    const res = await inbound.POST(webhook(big, { headers: { "content-length": "100" } }));
    expect(await errorCode(res)).toBe("bad_request");
    expectNoTrace();
  });

  it("a chunked body past 2 MB is refused part-way, without reading all of it", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        if (sent > 20 * TWO_MB) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const res = await inbound.POST(webhook(stream));
    expect(await errorCode(res)).toBe("bad_request");
    expect(sent).toBeLessThan(TWO_MB + 4 * 64 * 1024);
    expectNoTrace();
  });

  it("a body just under 2 MB is read and processed", async () => {
    const payload = postmarkPayload({ TextBody: "" });
    const padding = TWO_MB - JSON.stringify({ ...payload, StrippedTextReply: "" }).length - 10;
    const res = await inbound.POST(webhook({ ...payload, StrippedTextReply: "x".repeat(padding) }));
    expect(res.status).toBe(200);
    expect(fake.tasks).toHaveLength(1);
  });

  it.each([
    ["not JSON", "{not json"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["missing MessageID", JSON.stringify({ ...postmarkPayload(), MessageID: undefined })],
    ["an empty MessageID", JSON.stringify(postmarkPayload({ MessageID: "" }))],
    ["a FromFull that's a string", JSON.stringify(postmarkPayload({ FromFull: "sam.tester@mail.example" }))],
  ])("malformed (%s): 400, nothing recorded", async (_label, body) => {
    const res = await inbound.POST(webhook(body));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("bad_request");
    expectNoTrace();
  });

  it("a payload with no To (and no envelope recipient) leaves no trace", async () => {
    const res = await inbound.POST(webhook(postmarkPayload({ ToFull: [], CcFull: [], BccFull: [], OriginalRecipient: undefined, To: "" })));
    // Refused as unreadable (400): Postmark will retry it, which is harmless, and nothing is recorded.
    expect(res.status).toBeLessThan(500);
    expectNoTrace();
  });

  it("only the envelope recipient carries the token (sent by Bcc): found", async () => {
    const res = await inbound.POST(webhook(postmarkPayload({ ToFull: [{ Email: "friend@mail.example" }] })));
    expect(res.status).toBe(200);
    expect(fake.tasks).toHaveLength(1);
  });

  it.each([
    ["an unknown token", `${FORWARDING_CONFIG.prefix}${"e".repeat(32)}@${FORWARDING_CONFIG.domain}`],
    ["a token-like string that isn't hex", `${FORWARDING_CONFIG.prefix}${"z".repeat(32)}@${FORWARDING_CONFIG.domain}`],
    ["the right token at another domain", `${FORWARDING_CONFIG.prefix}${TOKEN}@evil.example`],
    ["the right token without the prefix", `${TOKEN}@${FORWARDING_CONFIG.domain}`],
  ])("%s: answered { received: true } and leaves no trace, the same as a real one would look", async (_label, to) => {
    const res = await inbound.POST(webhook(postmarkPayload({ ToFull: [{ Email: to }], OriginalRecipient: to })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expectNoTrace();
  });

  it("a redelivered message is answered and skipped, also when it arrives while the first is still processing", async () => {
    await inbound.POST(webhook(postmarkPayload()));
    // Not processed yet (the after() task hasn't run): a retry now is still a redelivery.
    const again = await inbound.POST(webhook(postmarkPayload({ Subject: "different", HtmlBody: "<p>changed</p>" })));
    expect(await again.json()).toEqual({ received: true });
    expect(fake.tasks).toHaveLength(1);
    await runAfterTasks();
    await inbound.POST(webhook(postmarkPayload()));
    expect(fake.tasks).toHaveLength(0);
    expect(fake.email.orderReader.calls).toHaveLength(1);
    expect(fake.email.items.rows.size).toBe(2);
  });

  it("attachments never reach the model", async () => {
    await inbound.POST(webhook(postmarkPayload({ Attachments: [{ Name: "a.txt", Content: Buffer.from("SECRET-ATTACHMENT").toString("base64"), ContentType: "text/plain" }] })));
    await runAfterTasks();
    expect(JSON.stringify(fake.email.orderReader.calls)).not.toContain("SECRET-ATTACHMENT");
    expect(JSON.stringify(fake.email.orderReader.calls)).not.toContain(Buffer.from("SECRET-ATTACHMENT").toString("base64"));
  });
});

describe("sender checks through the route", () => {
  const FORGED_BELOW: Header[] = [
    { Name: "Received-SPF", Value: "pass identity=mailfrom; envelope-from=sam.tester@mail.example" },
    { Name: "Authentication-Results", Value: "mx.inbound.example; spf=pass smtp.mailfrom=mail.example; dkim=pass header.d=mail.example; dmarc=pass" },
    { Name: "X-Spam-Status", Value: "No" },
    { Name: "X-Spam-Score", Value: "-9" },
  ];

  it("forged pass headers inside the email lose to Postmark's own failing ones: failed_checks, nothing read", async () => {
    const headers = fixtureHeaders().map((h) => (h.Name === "Received-SPF" ? { ...h, Value: "fail (not authorized) identity=mailfrom; envelope-from=sam.tester@mail.example" } : h));
    const res = await inbound.POST(webhook(postmarkPayload({ Headers: [...headers, ...FORGED_BELOW] })));
    expect(await res.json()).toEqual({ received: true });
    expect(fake.tasks).toHaveLength(0);
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "failed_checks" })]);
  });

  it("with INBOUND_EMAIL_AUTHSERV_ID set, a forged trusted Authentication-Results below the real one is ignored", async () => {
    vi.stubEnv("INBOUND_EMAIL_AUTHSERV_ID", "mx.inbound.example");
    const real = { Name: "Authentication-Results", Value: "mx.inbound.example; spf=softfail smtp.mailfrom=mail.example; dkim=none; dmarc=fail header.from=mail.example" };
    await inbound.POST(webhook(postmarkPayload({ Headers: [real, ...fixtureHeaders(), ...FORGED_BELOW] })));
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "failed_checks" })]);
  });

  it("spam (Postmark's top verdict) is refused even with forged 'No' headers below", async () => {
    const headers = fixtureHeaders().map((h) => (h.Name === "X-Spam-Status" ? { ...h, Value: "Yes, score=12.0" } : h));
    await inbound.POST(webhook(postmarkPayload({ Headers: [...headers, ...FORGED_BELOW] })));
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "failed_checks" })]);
  });

  it("From display-name trick: the user's address as a display name is refused as sender_not_allowed", async () => {
    await inbound.POST(webhook(postmarkPayload({ From: '"sam.tester@mail.example" <attacker@evil.example>', FromName: "sam.tester@mail.example", FromFull: { Email: "attacker@evil.example", Name: "sam.tester@mail.example" } })));
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "sender_not_allowed" })]);
    expect(fake.tasks).toHaveLength(0);
  });

  it("the user's From with SPF passed for another domain is refused", async () => {
    const headers = fixtureHeaders().map((h) => (h.Name === "Received-SPF" ? { ...h, Value: "pass identity=mailfrom; envelope-from=bounce@evil.example" } : h));
    await inbound.POST(webhook(postmarkPayload({ Headers: headers })));
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "failed_checks" })]);
  });

  // BUG (medium), end to end: see qa-email-import.test.ts. A MAIL FROM with
  // a quoted local part makes SPF for the attacker's domain read as the
  // user's domain, so an email "From" the user, sent by the attacker, is
  // accepted and its items added to the user's wardrobe.
  it.fails("BUG: SPF passed for evil.example can't be read as the user's domain through a quoted MAIL FROM", async () => {
    const spoof = 'pass (evil.example: 198.51.100.7 is authorized) identity=mailfrom; client-ip=198.51.100.7; helo=mx.evil.example; envelope-from="x; envelope-from=sam.tester@mail.example"@evil.example; receiver=p-pm-inbound';
    const headers = fixtureHeaders().map((h) => (h.Name === "Received-SPF" ? { ...h, Value: spoof } : h));
    await inbound.POST(webhook(postmarkPayload({ Headers: headers })));
    expect(fake.tasks).toHaveLength(0);
    expect(await listImports()).toEqual([expect.objectContaining({ status: "failed", error: "failed_checks" })]);
  });
});

describe("caps through the route", () => {
  it("the email cap: over it the email is recorded failed (daily_cap_reached), answered 200, and not read", async () => {
    fake.email = makeEmailDeps(fake.email.deps.network, {
      orderReplies: [NEXT_REPLY.replaceAll("https://", "http://")],
      taggerOutputs: [JSON.stringify(tagging.valid)],
      limits: { ...EMAIL_TEST_LIMITS, dailyCaps: { ...EMAIL_TEST_LIMITS.dailyCaps, email_import: 1 } },
    });
    fake.email.imports.tokens.set(TOKEN, { userId: TEST_USER, email: USER_EMAIL });
    expect((await inbound.POST(webhook(postmarkPayload({ MessageID: "one" })))).status).toBe(200);
    expect((await inbound.POST(webhook(postmarkPayload({ MessageID: "two" })))).status).toBe(200);
    expect(fake.tasks).toHaveLength(1);
    await runAfterTasks();
    const imports = await listImports();
    expect(imports.map((i) => [i.status, i.error, i.itemCount])).toEqual(expect.arrayContaining([["done", null, 2], ["failed", "daily_cap_reached", 0]]));
  });

  it("the item cap reached mid-email: the import shows the right counts and the usage agrees", async () => {
    fake.email = makeEmailDeps(fake.email.deps.network, {
      orderReplies: [NEXT_REPLY.replaceAll("https://", "http://")],
      taggerOutputs: [JSON.stringify(tagging.valid)],
      limits: { ...EMAIL_TEST_LIMITS, dailyCaps: { ...EMAIL_TEST_LIMITS.dailyCaps, item_ingest: 1 } },
    });
    fake.email.imports.tokens.set(TOKEN, { userId: TEST_USER, email: USER_EMAIL });
    await inbound.POST(webhook(postmarkPayload()));
    await runAfterTasks();
    expect(await listImports()).toEqual([expect.objectContaining({ status: "done", itemCount: 1, skippedCount: 1, error: "daily_cap_reached" })]);
    expect(fake.email.items.rows.size).toBe(1);
    expect(fake.email.storage.objects.size).toBe(1);
    expect((await fake.email.deps.usage.summary(TEST_USER)).itemsToday.used).toBe(1);
  });
});

describe("settings routes", () => {
  const get = () => settings.GET(new Request(`${BASE}/api/settings`));
  const put = (body: unknown, contentType = "application/json") =>
    settings.PUT(new Request(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const reset = () => forwardingAddress.POST(new Request(`${BASE}/api/settings/forwarding-address`, { method: "POST" }));
  const ALL_IDS = SHOPS.map((s) => s.id);

  it.each([
    ["an unknown shop", ["next", "primark-outlet"]],
    ["a shop ID in the wrong case", ["NEXT"]],
    ["a shop ID with spaces", [" next "]],
    ["a duplicate", ["next", "zara", "next"]],
    ["too many (every shop plus one repeat)", [...ALL_IDS, ALL_IDS[0]]],
    ["far too many", Array.from({ length: 1000 }, () => "next")],
    ["an empty list", []],
    ["a number", [1]],
    ["null in the list", ["next", null]],
    ["a string, not a list", "next"],
    ["an object", { next: true }],
    ["a prototype key", ["__proto__"]],
  ])("PUT refuses %s with 400 and changes nothing", async (_label, favouriteShopIds) => {
    const res = await put({ favouriteShopIds });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("bad_request");
    expect(fake.settings.rows.get(TEST_USER)?.favouriteShopIds).toEqual(["next", "marks_and_spencer", "new_look"]);
  });

  it("PUT accepts every shop at once, in the order given", async () => {
    const reversed = [...ALL_IDS].reverse();
    expect(UserSettingsSchema.parse(await (await put({ favouriteShopIds: reversed })).json()).favouriteShopIds).toEqual(reversed);
  });

  it("PUT can't change the forwarding token or address, whatever the body adds", async () => {
    const res = await put({ favouriteShopIds: ["zara"], forwardingToken: "f".repeat(32), forwarding_token: "f".repeat(32), forwardingAddress: "x@evil.example" });
    expect(res.status).toBe(200);
    expect(fake.settings.rows.get(TEST_USER)?.forwardingToken).toBe(TOKEN);
    expect(UserSettingsSchema.parse(await res.json()).forwardingAddress).toContain(TOKEN);
  });

  it("PUT refuses a body that isn't JSON", async () => {
    expect((await put("favouriteShopIds=next")).status).toBeGreaterThanOrEqual(400);
    expect((await put("{", "application/json")).status).toBe(400);
  });

  it("resetting twice gives two different random tokens; mail to either old address is then ignored, mail to the new one works", async () => {
    const first = UserSettingsSchema.parse(await (await reset()).json()).forwardingAddress!;
    const second = UserSettingsSchema.parse(await (await reset()).json()).forwardingAddress!;
    expect(new Set([first, second, `${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`]).size).toBe(3);
    expect(second).toMatch(/^4f1c2a9be0d34e7a8b5c6d7e8f901234\+[0-9a-f]{32}@inbound\.postmark\.example$/);
    expect(UserSettingsSchema.parse(await (await get()).json()).forwardingAddress).toBe(second);

    for (const [i, to] of [`${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`, first].entries()) {
      expect(await (await inbound.POST(webhook(postmarkPayload({ MessageID: `old-${i}`, ToFull: [{ Email: to }], OriginalRecipient: to })))).json()).toEqual({ received: true });
    }
    expectNoTrace();
    await inbound.POST(webhook(postmarkPayload({ MessageID: "new", ToFull: [{ Email: second }], OriginalRecipient: second })));
    expect(fake.tasks).toHaveLength(1);
  });

  it("reset takes no input: a body asking for a chosen token is ignored", async () => {
    const res = await forwardingAddress.POST(
      new Request(`${BASE}/api/settings/forwarding-address`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "a".repeat(32) }) }),
    );
    expect(res.status).toBe(200);
    expect(fake.settings.rows.get(TEST_USER)?.forwardingToken).not.toBe("a".repeat(32));
    expect(fake.settings.rows.get(TEST_USER)?.forwardingToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a missing settings row is a 500 (our bug), not someone else's settings", async () => {
    fake.settings.rows.delete(TEST_USER);
    fake.settings.rows.set(OTHER_USER, { favouriteShopIds: ["zara"], forwardingToken: "c".repeat(32) });
    expect((await get()).status).toBe(500);
    expect((await reset()).status).toBe(500);
    expect(fake.settings.rows.get(OTHER_USER)?.forwardingToken).toBe("c".repeat(32));
  });

  it("the address is null without INBOUND_EMAIL_DOMAIN, also from PUT and reset", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
    expect(UserSettingsSchema.parse(await (await put({ favouriteShopIds: ["zara"] })).json()).forwardingAddress).toBeNull();
    expect(UserSettingsSchema.parse(await (await reset()).json()).forwardingAddress).toBeNull();
  });

  it("a cross-site PUT or reset is refused", async () => {
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" };
    expect((await settings.PUT(new Request(`${BASE}/api/settings`, { method: "PUT", headers: cross, body: JSON.stringify({ favouriteShopIds: ["zara"] }) }))).status).toBe(403);
    expect((await forwardingAddress.POST(new Request(`${BASE}/api/settings/forwarding-address`, { method: "POST", headers: cross }))).status).toBe(403);
    expect(fake.settings.rows.get(TEST_USER)?.forwardingToken).toBe(TOKEN);
  });
});

describe("GET /api/email-imports lists only the user's own", () => {
  it("another user's imports never appear; newest first; at most 20", async () => {
    for (let i = 0; i < 25; i++) {
      const id = await fake.email.imports.start(TEST_USER, messageHash(`h${i}`), new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
      await fake.email.imports.finish(id!, { status: "done", shopName: `Shop ${i}`, orderDate: null, itemCount: 1, skippedCount: 0, error: null });
    }
    for (let i = 0; i < 5; i++) {
      const id = await fake.email.imports.start(OTHER_USER, messageHash(`o${i}`), new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString());
      await fake.email.imports.finish(id!, { status: "done", shopName: "Other person's shop", orderDate: null, itemCount: 9, skippedCount: 0, error: null });
    }
    const imports = await listImports();
    expect(imports).toHaveLength(20);
    expect(imports.some((i) => i.shopName === "Other person's shop")).toBe(false);
    expect(imports[0]!.shopName).toBe("Shop 24");
    expect(imports.map((i) => i.receivedAt)).toEqual([...imports.map((i) => i.receivedAt)].sort().reverse());
  });

  it("the Supabase reader filters by the signed-in user's ID (as well as RLS), newest first, limited", async () => {
    const calls: [string, unknown[]][] = [];
    const query = {
      select: (...a: unknown[]) => (calls.push(["select", a]), query),
      eq: (...a: unknown[]) => (calls.push(["eq", a]), query),
      order: (...a: unknown[]) => (calls.push(["order", a]), query),
      limit: async (...a: unknown[]) => (calls.push(["limit", a]), { data: [], error: null }),
    };
    const db = { from: (table: string) => (calls.push(["from", [table]]), query) };
    await new SupabaseEmailImportReader(db as never).list(TEST_USER, 20);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["from", ["email_imports"]],
        ["eq", ["user_id", TEST_USER]],
        ["order", ["received_at", { ascending: false }]],
        ["limit", [20]],
      ]),
    );
  });

  it("the Supabase reader refuses rows it can't vouch for (a row of another shape fails loudly rather than leaking)", async () => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [{ id: "x", sender: "someone@evil.example" }], error: null }) };
    await expect(new SupabaseEmailImportReader({ from: () => query } as never).list(TEST_USER, 20)).rejects.toThrow();
  });

  it("the token lookup ignores anything that isn't a token, without querying", async () => {
    const from = vi.fn();
    const repo = new SupabaseEmailImportRepository({ from } as never);
    for (const token of ["", "%", "*", "0".repeat(31), `${"0".repeat(32)}' or 1=1 --`, "A".repeat(32)]) expect(await repo.findUserByToken(token)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("needs a signed-in user", async () => {
    fake.signedIn = false;
    expect(await errorCode(await emailImports.GET(new Request(`${BASE}/api/email-imports`)))).toBe("unauthorized");
  });
});
