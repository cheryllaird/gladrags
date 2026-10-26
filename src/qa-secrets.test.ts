/**
 * QA: the Supabase secret key can't reach client bundles (CLAUDE.md,
 * "Secrets and safety"). Static checks over the source:
 * - only env.server.ts reads SUPABASE_SECRET_KEY, and it imports server-only;
 * - no client module ("use client", or the client image tools) imports,
 *   even indirectly, a module that reads the secret or is server-only;
 * - no secret-looking variable is NEXT_PUBLIC_ (which Next inlines);
 * - .env.example holds placeholders only.
 *
 * The built bundle is checked too (see the QA report: build with a canary
 * secret and grep .next/static), but that needs `pnpm build` first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = walk(SRC);
const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => relative(ROOT, f);

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (source.has(candidate)) return candidate;
  }
  return null;
}

function importsOf(file: string): { local: string[]; packages: string[] } {
  const text = source.get(file)!;
  const specs = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const local: string[] = [];
  const packages: string[] = [];
  for (const spec of specs) {
    // Type-only imports are erased and can't pull code into a bundle.
    const typeOnly = new RegExp(`import\\s+type\\s[^'"]*from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).test(text);
    if (typeOnly) continue;
    const resolved = resolveImport(file, spec);
    if (resolved) local.push(resolved);
    else packages.push(spec);
  }
  return { local, packages };
}

/** Every module a file pulls in, following local imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f).local);
  }
  return seen;
}

const isClientEntry = (f: string) => /^\s*["']use client["']/.test(source.get(f)!);
const clientEntries = [...files.filter(isClientEntry), join(SRC, "lib/images/index.ts"), join(SRC, "lib/images/types.ts")];

describe("secret key stays on the server", () => {
  it("is read only by src/lib/env.server.ts, which imports server-only", () => {
    const readers = files.filter((f) => /process\.env(\.SUPABASE_SECRET_KEY|\[["']SUPABASE_SECRET_KEY)/.test(source.get(f)!)).map(rel);
    expect(readers).toEqual(["src/lib/env.server.ts"]);
    expect(source.get(join(SRC, "lib/env.server.ts"))).toMatch(/^import "server-only";/m);
  });

  it("the admin client imports server-only too", () => {
    expect(source.get(join(SRC, "lib/supabase/admin.ts"))).toMatch(/import "server-only";/);
  });

  it("there are client modules to check", () => {
    expect(clientEntries.length).toBeGreaterThanOrEqual(3);
  });

  it.each(clientEntries.map(rel))("client module %s never imports server-only code, even indirectly", (entry) => {
    const reach = closure(join(ROOT, entry));
    const offenders = [...reach].filter((f) => {
      const text = source.get(f)!;
      return text.includes("SUPABASE_SECRET_KEY") || /import\s+["']server-only["']/.test(text) || f.endsWith("supabase/admin.ts");
    });
    expect(offenders.map(rel)).toEqual([]);
    const packages = [...reach].flatMap((f) => importsOf(f).packages);
    expect(packages).not.toContain("server-only");
    expect(packages).not.toContain("next/headers");
  });

  it("no source refers to a NEXT_PUBLIC_ variable that looks secret", () => {
    for (const [file, text] of source) {
      const names = [...text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0]);
      for (const name of names) expect(name, rel(file)).not.toMatch(/SECRET|SERVICE_ROLE|GEMINI|API_KEY|PRIVATE/);
    }
  });

  it(".env.example has placeholder values only, and no NEXT_PUBLIC_ secrets", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const vars = Object.fromEntries(
      example
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(vars.SUPABASE_SECRET_KEY).toBe("sb_secret_replace-me");
    expect(vars.GEMINI_API_KEY).toBe("replace-me");
    expect(vars.GLADRAGS_MOCK_MODE).toBe("false");
    for (const name of Object.keys(vars)) {
      if (name.startsWith("NEXT_PUBLIC_")) expect(name).not.toMatch(/SECRET|GEMINI|SERVICE/);
    }
  });

  it("real env files are gitignored, and only the placeholder template isn't", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    const lines = gitignore.split("\n").map((l) => l.trim());
    // Every .env file, whatever its suffix, except .env.example.
    expect(lines).toEqual(expect.arrayContaining([".env*", "!.env.example"]));
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf(".env*"));
    const ignored = (name: string) =>
      lines.reduce((state, line) => {
        if (line === ".env*" && name.startsWith(".env")) return true;
        if (line === `!${name}`) return false;
        return state;
      }, false);
    for (const name of [".env", ".env.local", ".env.production", ".env.development.local", ".env.vercel"]) expect(ignored(name), name).toBe(true);
    expect(ignored(".env.example")).toBe(false);
  });
});
