/**
 * Processing an accepted order email (CONTRACTS.md section 5, "Order
 * emails", steps 5 to 7). Runs after the webhook has answered the email
 * service, inside a time budget.
 *
 * 5. The model reads the email's text (HTML converted, links kept, cut to
 *    EMAIL_PROMPT_TEXT_MAX) and returns the clothing and shoe lines, checked
 *    against OrderEmailModelOutputSchema with one retry, each attempt
 *    metered as `email_extraction`.
 * 6. For each line, a few at a time: count an item (`item_ingest`), find
 *    a picture (the email's image link, else the product page) through the
 *    SSRF-safe fetcher, store it, tag it, and save the item with source
 *    `email` and "to review". No usable picture: a placeholder, `needsPhoto`,
 *    and tags from the line's text alone.
 * 7. Update the email_imports row with counts and status. The email itself
 *    is only ever in memory and is dropped when this returns. Nothing of it
 *    is logged.
 *
 * A line that isn't added (cap reached, tagging failed twice, our error)
 * counts in `skippedCount`, its stored picture is removed and its item
 * count given back. Anything left in storage by a crash part-way is an
 * image no item uses, which the daily orphaned-image cleanup deletes.
 */
import "server-only";
import {
  OrderEmailModelOutputSchema,
  STORAGE_BUCKETS,
  type EmailImportError,
  type EmailLineItem,
} from "@/contracts";
import { callWithValidation } from "@/lib/ai/validate";
import type { ImageInput, OrderEmailProvider, TaggingProvider } from "@/lib/ai/types";
import { describeError } from "@/lib/api/http";
import type { ServerImageProcessor } from "@/lib/images/server";
import { newImageKey, type ImageStorage } from "@/lib/ingestion/storage";
import type { ItemRepository } from "@/lib/ingestion/items-repository";
import { suggestTags, suggestTagsFromText, type TextTaggingHints } from "@/lib/ingestion/tagging";
import { saveItemRowForReview } from "@/lib/ingestion/wardrobe";
import { findProductImage, LINE_IMAGE_BUDGET_MS } from "@/lib/link-import/product-image";
import type { NetworkDeps } from "@/lib/link-import/safe-fetch";
import { CapReachedError, isAiPausedError } from "@/lib/usage/errors";
import type { UsageGuard, UsageReservation } from "@/lib/usage/guard";
import { emailTextForModel } from "./html-text";
import type { AcceptedEmail } from "./receive";
import type { EmailImportOutcome, EmailImportRepository } from "./repository";

export interface EmailProcessingDeps {
  imports: EmailImportRepository;
  usage: UsageGuard;
  orderReader: OrderEmailProvider;
  tagger: TaggingProvider;
  images: ServerImageProcessor;
  /** Admin storage: the webhook has no session. */
  storage: ImageStorage;
  /** Admin client: saves the items as "to review". */
  items: ItemRepository;
  network: NetworkDeps;
  placeholder: () => Promise<ImageInput>;
  /** Milliseconds, for the time budget. Defaults to Date.now. */
  clock?: () => number;
}

/**
 * Time for the whole email after the webhook answered: the model reading
 * it (two attempts of up to 30 s) and then its lines. Must stay under the
 * route's maxDuration (300 s), with room to record the result; a test
 * checks this.
 */
export const EMAIL_PROCESSING_BUDGET_MS = 240_000;

/** Lines handled at once: the shops' servers and Gemini answer in parallel. */
export const LINE_CONCURRENCY = 3;

/**
 * The longest one line can take: finding its picture (LINE_IMAGE_BUDGET_MS,
 * 20 s) plus tagging it with one retry (two attempts of up to 20 s,
 * TAGGING_ATTEMPT_TIMEOUT_MS). No new line starts with less than this left,
 * so a line that starts always has time to finish inside the budget.
 */
export const MIN_TIME_FOR_A_LINE_MS = 60_000;

/** Time kept back from a line's picture search for tagging it (two attempts). */
const TAGGING_RESERVE_MS = 40_000;

type LineOutcome = { added: true } | { added: false; reason: EmailImportError };

/** Which reason the import shows when several lines were skipped for different reasons. Most useful first. */
const REASON_ORDER: readonly EmailImportError[] = ["daily_cap_reached", "ai_paused", "ai_failed", "internal"];

/** Process an accepted email and record the outcome. Never throws. */
export async function processAcceptedEmail(deps: EmailProcessingDeps, accepted: AcceptedEmail): Promise<EmailImportOutcome> {
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + EMAIL_PROCESSING_BUDGET_MS;
  let outcome: EmailImportOutcome;
  try {
    outcome = await readAndAddItems(deps, accepted, deadline, clock);
  } catch (error) {
    console.error("Order email: processing failed", describeError(error));
    outcome = { status: "failed", shopName: null, orderDate: null, itemCount: 0, skippedCount: 0, error: "internal" };
  }
  try {
    await deps.imports.finish(accepted.importId, outcome);
  } catch (error) {
    // The row stays "processing" and reads as failed once it's stale.
    console.error("Order email: couldn't record the outcome", describeError(error));
  }
  return outcome;
}

async function readAndAddItems(deps: EmailProcessingDeps, accepted: AcceptedEmail, deadline: number, clock: () => number): Promise<EmailImportOutcome> {
  const { user, email } = accepted;
  const failed = (error: EmailImportError, order?: { shopName: string | null; orderDate: string | null }): EmailImportOutcome => ({
    status: "failed",
    shopName: order?.shopName ?? null,
    orderDate: order?.orderDate ?? null,
    itemCount: 0,
    skippedCount: 0,
    error,
  });

  const text = emailTextForModel(email);
  if (text.trim() === "") return failed("no_items_found");

  let result;
  try {
    result = await callWithValidation(
      OrderEmailModelOutputSchema,
      () => deps.orderReader.extractOrder({ subject: email.subject, text }),
      { ...deps.usage.meterAiCalls(user.userId, "email_extraction", deps.orderReader.name), provider: deps.orderReader.name },
    );
  } catch (error) {
    if (!isAiPausedError(error)) throw error;
    // Paused before the model read it: the user got nothing, so give the email count back.
    await accepted.counted.cancel().catch(() => {});
    return failed("ai_paused");
  }
  if (!result.ok) {
    console.warn("Order email: the model couldn't read it twice", { attempts: result.attempts });
    return failed("ai_failed");
  }

  const order = result.data;
  const lines = order.items;
  const orderInfo = { shopName: order.shopName, orderDate: order.orderDate };
  if (lines.length === 0) return failed("no_items_found", orderInfo);

  const outcomes = await mapWithConcurrency(lines, LINE_CONCURRENCY, (line) =>
    deadline - clock() < MIN_TIME_FOR_A_LINE_MS ? Promise.resolve<LineOutcome>({ added: false, reason: "internal" }) : addLine(deps, user.userId, line, deadline, clock),
  );

  const itemCount = outcomes.filter((o) => o.added).length;
  const reasons = new Set(outcomes.flatMap((o) => (o.added ? [] : [o.reason])));
  const reason = REASON_ORDER.find((r) => reasons.has(r)) ?? null;
  const skippedCount = outcomes.length - itemCount;
  if (itemCount === 0) return { ...failed(reason ?? "internal", orderInfo), skippedCount };
  return { status: "done", ...orderInfo, itemCount, skippedCount, error: skippedCount > 0 ? reason : null };
}

/** One line: count it, find and store its picture, tag it, save it "to review". */
async function addLine(deps: EmailProcessingDeps, userId: string, line: EmailLineItem, deadline: number, clock: () => number): Promise<LineOutcome> {
  let counted: UsageReservation;
  try {
    counted = await deps.usage.reserveAction(userId, "item_ingest");
  } catch (error) {
    if (error instanceof CapReachedError) return { added: false, reason: error.cap === "monthly_ai_spend" ? "ai_paused" : "daily_cap_reached" };
    console.error("Order email: couldn't count an item", describeError(error));
    return { added: false, reason: "internal" };
  }

  let storedKey: string | null = null;
  const undo = async () => {
    if (storedKey) await deps.storage.remove(STORAGE_BUCKETS.originals, [storedKey]).catch(() => {});
    await counted.cancel().catch(() => {});
  };

  try {
    const budget = Math.min(LINE_IMAGE_BUDGET_MS, deadline - clock() - TAGGING_RESERVE_MS);
    const found = budget > 0 ? await findProductImage(deps.images, line, deps.network, budget) : { image: null, product: null };
    const hints: TextTaggingHints = {
      title: line.name,
      brand: line.brand ?? found.product?.brand ?? null,
      colour: line.colour ?? found.product?.colour ?? null,
    };

    const image = found.image ?? (await deps.placeholder());
    storedKey = newImageKey(userId, image.mimeType);
    await deps.storage.upload(STORAGE_BUCKETS.originals, storedKey, image);

    const tags = found.image ? await suggestTags(deps, userId, found.image, hints) : await suggestTagsFromText(deps, userId, hints);
    if (!tags) {
      await undo();
      return { added: false, reason: "ai_failed" };
    }

    await saveItemRowForReview(deps.items, userId, {
      source: "email",
      sourceUrl: line.productUrl,
      originalImageKey: storedKey,
      cutoutImageKey: null,
      tags,
      needsPhoto: found.image === null,
    });
    return { added: true };
  } catch (error) {
    await undo();
    if (isAiPausedError(error)) return { added: false, reason: "ai_paused" };
    console.error("Order email: couldn't add a line", describeError(error));
    return { added: false, reason: "internal" };
  }
}

/** Run `work` over the items with at most `limit` at once, keeping the order of results. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
