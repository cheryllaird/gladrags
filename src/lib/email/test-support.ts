/**
 * Test helpers for order-email import (not used by the app). Everything in
 * memory: the email_imports table, items, storage and usage; a fake model
 * for reading emails and for tagging; shops are the link-import test
 * server behind a fake DNS. No real network or AI.
 */
import { readFileSync } from "node:fs";
import { FakeOrderEmailProvider, FakeTaggingProvider } from "@/lib/ai/fakes";
import { SharpImageProcessor } from "@/lib/images/sharp-processor";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage } from "@/lib/ingestion/storage";
import type { NetworkDeps } from "@/lib/link-import/safe-fetch";
import { UsageGuard, type UsageLimits } from "@/lib/usage/guard";
import { InMemoryUsageStore } from "@/lib/usage/store";
import { TEST_USER } from "@/test/ingestion-deps";
import type { InboundEmail } from "@/contracts";
import { placeholderImage } from "./placeholder";
import type { EmailProcessingDeps } from "./process";
import { InMemoryEmailImportRepository } from "./repository";

export function emailFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** The user who owns TOKEN, signed in as USER_EMAIL. */
export const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
export const USER_EMAIL = "sam.tester@mail.example";
/** Matches the recorded Postmark payload's inbound address. */
export const FORWARDING_CONFIG = { domain: "inbound.postmark.example", prefix: "4f1c2a9be0d34e7a8b5c6d7e8f901234+" };

/** Generous enough for one order; tests lower them to reach a cap. */
export const EMAIL_TEST_LIMITS: UsageLimits = {
  dailyCaps: { item_ingest: 40, outfit_request: 2, link_fetch: 20, email_import: 3, shop_search: 2 },
  monthlySpendCapPence: 500,
  timeZone: "Europe/London",
};

export function makeEmailDeps(
  network: NetworkDeps,
  { orderReplies = ["{}"] as unknown[], taggerOutputs = ["{}"] as unknown[], limits = EMAIL_TEST_LIMITS } = {},
) {
  let now = new Date("2026-10-30T10:00:00Z");
  const clock = () => now;
  const usageStore = new InMemoryUsageStore(clock);
  const imports = new InMemoryEmailImportRepository(clock);
  imports.tokens.set(TOKEN, { userId: TEST_USER, email: USER_EMAIL });
  const orderReader = new FakeOrderEmailProvider(orderReplies);
  const tagger = new FakeTaggingProvider(taggerOutputs);
  const storage = new InMemoryImageStorage(clock);
  const items = new InMemoryItemRepository(clock);
  const deps: EmailProcessingDeps = {
    imports,
    usage: new UsageGuard(usageStore, limits, clock),
    orderReader,
    tagger,
    images: new SharpImageProcessor(),
    storage,
    items,
    network,
    placeholder: placeholderImage,
  };
  return { deps, imports, orderReader, tagger, storage, items, usageStore, setNow: (iso: string) => (now = new Date(iso)) };
}

/** A normalised email that passes every check, from the user to their forwarding address. */
export function acceptedEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    messageId: "9c3b6f2a-1d4e-4b7a-8e2f-5a6b7c8d9e01",
    from: USER_EMAIL,
    to: [`${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`],
    subject: "Fwd: Thanks for your order",
    text: null,
    html: emailFixture("next-order.html"),
    receivedAt: "2026-10-30T10:00:00.000Z",
    auth: { spf: "pass", spfDomain: "mail.example", dkim: "none", dkimDomains: [], dmarc: "none" },
    spam: { isSpam: false, score: -0.1 },
    ...overrides,
  };
}
