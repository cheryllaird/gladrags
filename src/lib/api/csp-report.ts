/**
 * Reading Content Security Policy violation reports (POST /api/csp-report).
 * Browsers send them in two shapes:
 * - `report-uri` (Content-Type application/csp-report):
 *   { "csp-report": { "effective-directive": "...", "blocked-uri": "..." } }
 * - `report-to`, the Reporting API (application/reports+json):
 *   [{ "type": "csp-violation", "body": { "effectiveDirective": "...", "blockedURL": "..." } }]
 *
 * Only two things are kept from a report: the directive, and where the
 * blocked thing came from (an origin such as https://vercel.live, or a
 * keyword such as inline, eval, data or blob). Never the full URL, the
 * page, the referrer or a code sample: those can carry tokens or user data.
 */
import "server-only";

export interface CspReportSummary {
  directive: string;
  blocked: string;
}

/** Reports larger than this are dropped unread. Real ones are around 1 KB. */
export const MAX_CSP_REPORT_BYTES = 16 * 1024;
/** Reports read from one request (the Reporting API can batch them). */
export const MAX_REPORTS_PER_REQUEST = 10;

const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "self", "data", "blob", "trusted-types-policy", "trusted-types-sink"]);

function directiveOf(value: unknown): string {
  return typeof value === "string" && /^[a-z-]{1,40}$/.test(value) ? value : "unknown";
}

/** An origin, a URL scheme for data:/blob: and similar, a known keyword, or "other". */
export function blockedSource(value: unknown): string {
  if (typeof value !== "string" || value === "") return "none";
  if (KEYWORDS.has(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    return /^[a-z][a-z0-9+.-]{0,20}:$/.test(url.protocol) ? url.protocol.slice(0, -1) : "other";
  } catch {
    return "other";
  }
}

function summarise(report: Record<string, unknown>): CspReportSummary {
  return {
    directive: directiveOf(report["effective-directive"] ?? report.effectiveDirective ?? report["violated-directive"] ?? report.violatedDirective),
    blocked: blockedSource(report["blocked-uri"] ?? report.blockedURL),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The reports in a parsed request body, summarised. Anything unrecognised is skipped. */
export function summariseCspReports(body: unknown): CspReportSummary[] {
  const reports: Record<string, unknown>[] = [];
  if (isObject(body) && isObject(body["csp-report"])) reports.push(body["csp-report"]);
  if (Array.isArray(body)) {
    for (const entry of body) {
      if (isObject(entry) && entry.type === "csp-violation" && isObject(entry.body)) reports.push(entry.body);
    }
  }
  return reports.slice(0, MAX_REPORTS_PER_REQUEST).map(summarise);
}

/** Read at most `maxBytes` of a request body; null if it's longer. */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * A cheap per-server-instance limit on how many reports get logged, so
 * anyone posting junk can't flood the logs. Reports over it are dropped.
 */
export class LogBudget {
  private windowStart = 0;
  private used = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= this.perMinute) return false;
    this.used++;
    return true;
  }
}
