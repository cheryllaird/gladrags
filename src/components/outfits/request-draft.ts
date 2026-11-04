/**
 * The request form's state, and turning it into an outfit request. Pure,
 * so it's unit-tested without rendering the form.
 */
import {
  CUSTOM_STYLE_MAX_LENGTH,
  GUIDANCE_MAX_LENGTH,
  OUTFIT_COUNT,
  OutfitRequestSchema,
  type OutfitRequestInput,
  type PresetStyleId,
} from "@/contracts";

export interface RequestDraft {
  /** A preset chip, "custom" for "Something else", or null before choosing. */
  style: PresetStyleId | "custom" | null;
  customText: string;
  guidance: string;
  count: number;
  /** "Include items from my shops": outfits may include one suggested shop item. */
  includeShopItems: boolean;
}

export const EMPTY_DRAFT: RequestDraft = {
  style: null,
  customText: "",
  guidance: "",
  count: OUTFIT_COUNT.default,
  includeShopItems: false,
};

export type DraftResult =
  | { ok: true; request: OutfitRequestInput }
  | { ok: false; field: DraftField; message: string };

export type DraftField = "style" | "customText" | "guidance" | "count";

/** Collapse runs of whitespace (including pasted newlines) to single spaces. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function draftToRequest(draft: RequestDraft, anchorItemId: string | null): DraftResult {
  if (draft.style === null) {
    return { ok: false, field: "style", message: "Pick a style, or choose “Something else” and describe it." };
  }

  let style: OutfitRequestInput["style"];
  if (draft.style === "custom") {
    const text = oneLine(draft.customText);
    if (!text) return { ok: false, field: "customText", message: "Say what you're dressing for." };
    if (text.length > CUSTOM_STYLE_MAX_LENGTH) {
      return { ok: false, field: "customText", message: `Keep it to ${CUSTOM_STYLE_MAX_LENGTH} characters or fewer.` };
    }
    style = { kind: "custom", text };
  } else {
    style = { kind: "preset", presetId: draft.style };
  }

  const guidance = oneLine(draft.guidance);
  if (guidance.length > GUIDANCE_MAX_LENGTH) {
    return { ok: false, field: "guidance", message: `Keep guidance to ${GUIDANCE_MAX_LENGTH} characters or fewer.` };
  }

  const request: OutfitRequestInput = {
    style,
    count: draft.count,
    ...(guidance ? { guidance } : {}),
    ...(anchorItemId ? { anchorItemId } : {}),
    // Left out when off: the contract reads a missing flag as false.
    ...(draft.includeShopItems ? { includeShopItems: true } : {}),
  };
  // Belt and braces: the contract is the final word on what's valid.
  const checked = OutfitRequestSchema.safeParse(request);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return { ok: false, field: fieldFor(issue?.path[0], draft), message: issue?.message ?? "Check your request." };
  }
  return { ok: true, request };
}

/** Which form field a contract failure belongs to, so the message shows beside it. */
function fieldFor(path: PropertyKey | undefined, draft: RequestDraft): DraftField {
  if (path === "count") return "count";
  if (path === "guidance") return "guidance";
  if (path === "style" && draft.style === "custom") return "customText";
  // The style itself, or an anchor ID that isn't valid (not something the user typed).
  return "style";
}
