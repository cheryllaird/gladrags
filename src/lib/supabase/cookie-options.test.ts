/**
 * Both server-side Supabase clients set httpOnly, SameSite=Lax session
 * cookies (Secure in production), and nothing in the browser reads the
 * session.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: Record<string, unknown>) => {
    captured.options.push(options);
    return { auth: { getUser: async () => ({ data: { user: null } }) } };
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

import { sessionCookieOptions } from "./cookie-options";
import { updateSession } from "./proxy";
import { createClient } from "./server";

beforeEach(() => {
  captured.options = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
});

afterEach(() => vi.unstubAllEnvs());

describe("session cookie options", () => {
  it("are httpOnly and SameSite=Lax, Secure only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: "lax" });
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, secure: false, sameSite: "lax" });
  });

  it("are passed by the route-handler client and the proxy client", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createClient();
    await updateSession(new NextRequest("https://gladrags.example/wardrobe"));
    expect(captured.options).toHaveLength(2);
    for (const options of captured.options) {
      expect(options.cookieOptions).toEqual({ httpOnly: true, secure: true, sameSite: "lax" });
    }
  });
});

describe("nothing in the browser reads the session", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("no source file uses a browser Supabase client or document.cookie", () => {
    const offenders = files(join(process.cwd(), "src"))
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => /createBrowserClient|document\.cookie|sb-[\w-]*auth-token/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
