import { notFound } from "next/navigation";
import { isMockMode } from "@/lib/env";
import { CutoutHarness } from "./cutout-harness";

/**
 * Dev-only test bench for the in-browser background remover (owner:
 * ingestion). Lets end-to-end tests run the real model in a real browser.
 * Only exists in mock mode; everywhere else it's a 404.
 */
export const dynamic = "force-dynamic";

export default function CutoutDevPage() {
  let allowed = false;
  try {
    allowed = isMockMode();
  } catch {
    allowed = false;
  }
  if (!allowed) notFound();
  return <CutoutHarness />;
}
