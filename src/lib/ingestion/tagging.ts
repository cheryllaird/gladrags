/**
 * The tagging step, shared by add-by-photo and add-by-link (link-import
 * calls suggestTags from its step 2).
 *
 * Spec: the vision model returns tags as strict JSON; anything that fails
 * the item tags schema is retried once, then the user gets empty tags to
 * fill in. Every attempt's cost is reserved against the monthly AI cap
 * before the call is made.
 */
import "server-only";
import { TaggingModelOutputSchema, type ItemTags } from "@/contracts";
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
 * Tag one item from its cut-out (or the original if there's no cut-out).
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
  const result = await callWithValidation(
    TaggingModelOutputSchema,
    () => deps.tagger.tagItem({ image: modelImage, ...(productHints ? { productHints } : {}) }),
    {
      // Each attempt reserves its estimated cost first (ai_paused if the
      // month's cap is reached), then records the real cost.
      ...deps.usage.meterAiCalls(userId, "tagging", deps.tagger.name),
      provider: deps.tagger.name,
    },
  );
  if (result.ok) return result.data;
  console.warn("Tagging failed twice; returning empty tags", {
    attempts: result.attempts,
    errors: result.errors.map((e) => e.slice(0, 300)),
  });
  return null;
}
