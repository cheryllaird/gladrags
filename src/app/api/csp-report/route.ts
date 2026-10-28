// Content Security Policy reports (next.config.ts: report-uri and
// report-to). Browsers post here when a page breaks the policy. Each report
// is logged as "CSP report" with only its directive and the blocked
// source's origin (src/lib/api/csp-report.ts); see CONTRACTS.md section 9
// for how to read them.
//
// No sign-in, and not behind withApiHandler's CSRF check: browsers send
// these themselves, and a report changes nothing. Bodies over 16 KB are
// refused unread, and at most 60 reports a minute are logged per server
// instance; the rest are dropped. It always answers 204 for a body it
// read, so it tells a sender nothing.
import { NextResponse } from "next/server";
import { LogBudget, MAX_CSP_REPORT_BYTES, readLimitedText, summariseCspReports } from "@/lib/api/csp-report";

const budget = new LogBudget(60);

export async function POST(request: Request) {
  const text = await readLimitedText(request, MAX_CSP_REPORT_BYTES).catch(() => null);
  if (text === null) return new NextResponse(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  for (const report of summariseCspReports(body)) {
    if (!budget.take()) break;
    console.warn("CSP report", report);
  }
  return new NextResponse(null, { status: 204 });
}
