/**
 * The sign-in routes' rate limits, through the route handlers in mock
 * mode: the 6th request for one email in 15 minutes is a 429, invited or
 * not, so the limit can't be used to tell which emails are on the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema } from "@/contracts";
import * as magicLink from "./magic-link/route";
import * as verifyCode from "./verify-code/route";

const store = globalThis as unknown as { __gladragsMockSignInAttempts?: unknown };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

async function codeOf(response: Response) {
  return ApiErrorSchema.parse(await response.json()).error.code;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  delete store.__gladragsMockSignInAttempts;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete store.__gladragsMockSignInAttempts;
});

describe("POST /api/auth/magic-link", () => {
  it.each(["tester@example.com", "not-invited@example.com"])("allows 5 requests for %s, then answers 429 rate_limited", async (email) => {
    for (let i = 0; i < 5; i++) {
      const res = await magicLink.POST(post("/api/auth/magic-link", { email }));
      expect(res.status).not.toBe(429);
    }
    const res = await magicLink.POST(post("/api/auth/magic-link", { email }));
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe("rate_limited");
  });

  it("an uninvited email's 6th try gets exactly the same answer as an invited one's", async () => {
    const answers: unknown[] = [];
    for (const email of ["tester@example.com", "not-invited@example.com"]) {
      for (let i = 0; i < 5; i++) await magicLink.POST(post("/api/auth/magic-link", { email }));
      const res = await magicLink.POST(post("/api/auth/magic-link", { email }));
      answers.push({ status: res.status, body: await res.json() });
    }
    expect(answers[0]).toEqual(answers[1]);
  });

  it("limits one IP address across many emails (20 per 15 minutes)", async () => {
    const ip = { "x-forwarded-for": "203.0.113.50" };
    for (let i = 0; i < 20; i++) await magicLink.POST(post("/api/auth/magic-link", { email: `t${i}@example.com` }, ip));
    const res = await magicLink.POST(post("/api/auth/magic-link", { email: "t99@example.com" }, ip));
    expect(await codeOf(res)).toBe("rate_limited");
    // A different address still works.
    const other = await magicLink.POST(post("/api/auth/magic-link", { email: "t99@example.com" }, { "x-forwarded-for": "198.51.100.50" }));
    expect(other.status).toBe(200);
  });

  it("a malformed request is a 400 and isn't counted", async () => {
    for (let i = 0; i < 10; i++) expect((await magicLink.POST(post("/api/auth/magic-link", { email: "nope" }))).status).toBe(400);
    expect((await magicLink.POST(post("/api/auth/magic-link", { email: "tester@example.com" }))).status).toBe(200);
  });
});

describe("POST /api/auth/verify-code", () => {
  it("allows 5 code checks per email, then 429: a 6-digit code can't be guessed", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await verifyCode.POST(post("/api/auth/verify-code", { email: "tester@example.com", code: String(100000 + i) }));
      expect(res.status).toBe(200); // mock mode accepts any code
    }
    const res = await verifyCode.POST(post("/api/auth/verify-code", { email: "tester@example.com", code: "123456" }));
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe("rate_limited");
  });
});
