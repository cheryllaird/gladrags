/**
 * Words the outfit screens show: labels for styles and categories, and
 * friendly messages for each API error. Pure functions, unit-tested.
 */
import { PRESET_STYLES_BY_ID, type Category, type StyleChoice, type Subcategory } from "@/contracts";
import type { ApiFailure } from "./api";

/** "Add …" wording for the missing-category message. */
export const CATEGORY_LABELS: Record<Category, { singular: string; plural: string; add: string }> = {
  top: { singular: "Top", plural: "Tops", add: "Add a top" },
  bottom: { singular: "Bottom", plural: "Bottoms", add: "Add trousers, jeans or a skirt" },
  dress_jumpsuit: { singular: "Dress or jumpsuit", plural: "Dresses and jumpsuits", add: "Add a dress or jumpsuit" },
  outerwear: { singular: "Outerwear", plural: "Outerwear", add: "Add a jacket or coat" },
  shoes: { singular: "Shoes", plural: "Shoes", add: "Add shoes" },
};

/** "t_shirt" -> "T-shirt", "smart_shoes" -> "Smart shoes". */
export function subcategoryLabel(subcategory: Subcategory): string {
  if (subcategory === "t_shirt") return "T-shirt";
  const words = subcategory.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Smart casual", or the user's own words in quotes. */
export function styleLabel(style: StyleChoice): string {
  return style.kind === "preset" ? PRESET_STYLES_BY_ID[style.presetId].label : `“${style.text}”`;
}

/**
 * When the engine finds fewer outfits than were asked for (the contract
 * allows 1 to count): say so, and how to get more.
 */
export function fewerOutfitsMessage(found: number): string {
  const what = found === 1 ? "1 outfit that fits" : `${found} that fit`;
  return `Only found ${what}. Add more items to your wardrobe for more ideas.`;
}

/** One-tap refinements shown on each outfit. The text is sent as guidance. */
export const QUICK_REFINEMENTS = ["Warmer", "Cooler", "Less formal", "Smarter"] as const;

const RESET_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/London",
});

/**
 * e.g. "Sun 1 Nov, 00:00". Caps reset on UK time, so show UK time. Built
 * from parts because browsers and Node punctuate the full format differently.
 */
export function formatResetTime(iso: string): string {
  const parts = Object.fromEntries(
    RESET_TIME_FORMAT.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  ) as Partial<Record<Intl.DateTimeFormatPartTypes, string>>;
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

export interface ErrorCopy {
  title: string;
  message: string;
  /** Worth offering "Try again" straight away. */
  retryable: boolean;
}

/** A friendly title and message for an API error. */
export function describeApiError(error: ApiFailure): ErrorCopy {
  const resets = error.cap ? formatResetTime(error.cap.resetsAt) : null;
  switch (error.code) {
    case "ai_paused":
      return {
        title: "Outfit ideas are paused for now",
        message: `GladRags has used this month's AI budget, so new outfits are paused${
          resets ? ` until ${resets}` : " until next month"
        }. Your wardrobe and saved outfits still work.`,
        retryable: false,
      };
    case "daily_cap_reached":
      return {
        title: "That's today's outfit ideas used up",
        message: `You've reached today's limit${error.cap ? ` of ${error.cap.limit} outfit requests` : ""}. It resets ${
          resets ? `at ${resets}` : "at midnight"
        }. Your saved outfits are still here.`,
        retryable: false,
      };
    case "ai_failed":
      return {
        title: "We couldn't put outfits together",
        message: "Something went wrong while picking outfits. Please try again in a moment.",
        retryable: true,
      };
    case "bad_request":
      return { title: "Check your request", message: error.message, retryable: false };
    case "not_found":
      return { title: "Not found", message: error.message, retryable: false };
    case "unauthorized":
      return { title: "You're signed out", message: "Sign in again to get outfit ideas.", retryable: false };
    default:
      return {
        title: "Something went wrong",
        message: error.message || "Please try again.",
        retryable: true,
      };
  }
}
