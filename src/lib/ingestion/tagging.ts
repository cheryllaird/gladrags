/**
 * The tagging step, shared by add-by-photo, add-by-link and order emails
 * (link-import calls suggestTags from link step 2 and for email lines with
 * a picture, and suggestTagsFromText for email lines without one).
 *
 * Spec: the vision model returns tags as strict JSON; anything that fails
 * the item tags schema is retried once, then the user gets empty tags to
 * fill in. Every attempt's cost is reserved against the monthly AI cap
 * before the call is made.
 */
import "server-only";
import { z } from "zod";
import { EMAIL_LINE_ITEM_LIMITS, TaggingModelOutputSchema, scrapedText, type EmailLineItem, type ItemTags } from "@/contracts";
import { canTagFromText } from "@/lib/ai/tagging-input";
import { callWithValidation } from "@/lib/ai/validate";
import type { ImageInput, TaggingInput, TaggingProvider } from "@/lib/ai/types";
import { TAGGING_IMAGE_PX, type ServerImageProcessor } from "@/lib/images/server";
import type { UsageGuard } from "@/lib/usage/guard";

export interface TaggingDeps {
  images: ServerImageProcessor;
  tagger: TaggingProvider;
  usage: UsageGuard;
}

/**
 * Tag one item from its picture: the original, or a cut-out where an older
 * client sent one.
 * Returns null when the model fails twice: the draft then has
 * suggestedTags: null and the user fills the tags in.
 *
 * The caller must already have checked the caps (UsageGuard.assertCanStart).
 */
export async function suggestTags(
  deps: TaggingDeps,
  userId: string,
  image: ImageInput,
  productHints?: TaggingInput["productHints"],
): Promise<ItemTags | null> {
  // Small, flattened JPEG: cheaper and quicker than the full PNG cut-out.
  const modelImage = await deps.images.prepareForModel(image, TAGGING_IMAGE_PX);
  return tagWithRetry(deps, userId, { image: modelImage, ...(productHints ? { productHints } : {}) });
}

/**
 * Product details for tagging an item without a picture: an order-email
 * line's name (as `title`), brand and colour. The title is required.
 */
export interface TextTaggingHints {
  title: EmailLineItem["name"];
  brand?: EmailLineItem["brand"];
  colour?: EmailLineItem["colour"];
}

/**
 * The hints as they may reach a prompt, cleaned with the contract's rules
 * for email text whatever the caller passed: single line (line breaks and
 * other whitespace flattened to spaces), length-limited like an email line
 * item, and blank read as null.
 */
const TextTaggingHintsSchema = z.object({
  title: scrapedText(EMAIL_LINE_ITEM_LIMITS.name),
  brand: scrapedText(EMAIL_LINE_ITEM_LIMITS.brand),
  colour: scrapedText(EMAIL_LINE_ITEM_LIMITS.colour),
});

/**
 * Tag one item from its product details alone, for an order-email line
 * with no usable picture (CONTRACTS.md section 11, decision 13). Same
 * validation, single retry, cost metering and fallback as suggestTags.
 * The hints are cleaned first (TextTaggingHintsSchema). Returns null
 * without calling the model if the title is blank.
 *
 * The caller must already have checked the caps (UsageGuard.assertCanStart).
 */
export async function suggestTagsFromText(
  deps: Pick<TaggingDeps, "tagger" | "usage">,
  userId: string,
  productHints: TextTaggingHints,
): Promise<ItemTags | null> {
  const parsed = TextTaggingHintsSchema.safeParse({
    title: productHints.title,
    brand: productHints.brand ?? null,
    colour: productHints.colour ?? null,
  });
  if (!parsed.success || !canTagFromText(parsed.data)) return null;
  return tagWithRetry(deps, userId, { image: null, productHints: parsed.data });
}

async function tagWithRetry(deps: Pick<TaggingDeps, "tagger" | "usage">, userId: string, input: TaggingInput): Promise<ItemTags | null> {
  const result = await callWithValidation(TaggingModelOutputSchema, () => deps.tagger.tagItem(input), {
    // Each attempt reserves its estimated cost first (ai_paused if the
    // month's cap is reached), then records the real cost.
    ...deps.usage.meterAiCalls(userId, "tagging", deps.tagger.name),
    provider: deps.tagger.name,
  });
  if (result.ok) return result.data;
  console.warn("Tagging failed twice; returning empty tags", {
    withImage: input.image !== null,
    attempts: result.attempts,
    errors: result.errors.map((e) => e.slice(0, 300)),
  });
  return null;
}
