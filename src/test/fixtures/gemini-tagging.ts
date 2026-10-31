/**
 * Gemini tagging replies, in the shape the @google/genai SDK returns
 * (`text` plus `usageMetadata`), replayed by src/lib/ai/gemini-tagging.test.ts.
 *
 * Provenance: gemini-3.8-flash answered every live call on 2026-10-25 with
 * 503 "high demand", so these replies are hand-written in the recorded
 * shape, not captured. Token counts are typical for one ~768 px image plus
 * this prompt. Replace them with real recordings once a live call succeeds
 * (the ingestion agent's report says how).
 */

export interface RecordedReply {
  text: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

const usage = { promptTokenCount: 1712, candidatesTokenCount: 96, thoughtsTokenCount: 184, totalTokenCount: 1992 };

export const GEMINI_TAGGING_RECORDINGS = {
  good: {
    /** A navy t-shirt cut-out on the grey model background. */
    tshirtCutout: {
      text: '{"category":"top","subcategory":"t_shirt","colours":["navy"],"pattern":"plain","formality":1,"seasons":["spring","summer","autumn"],"warmth":"light","occasions":["comfy","casual","active","holiday"],"fabric":"","description":"Navy crew-neck short-sleeve t-shirt"}',
      usageMetadata: usage,
    },
    /** A red and navy check skirt, with (injection-laced) product hints. */
    skirtWithHints: {
      text: '{"category":"bottom","subcategory":"skirt","colours":["red","navy","yellow"],"pattern":"check","formality":2,"seasons":["autumn","winter"],"warmth":"medium","occasions":["casual","smart_casual"],"fabric":"wool","description":"Red tartan A-line mini skirt"}',
      usageMetadata: { ...usage, promptTokenCount: 1801 },
    },
  },
  textOnly: {
    /**
     * An order-email line with no picture: "Stretch Slim Chinos", Next,
     * colour "Stone". Text only, so far fewer prompt tokens. Hand-written,
     * like the others.
     */
    chinosFromEmail: {
      text: '{"category":"bottom","subcategory":"chinos","colours":["beige"],"pattern":"plain","formality":3,"seasons":["spring","summer","autumn"],"warmth":"medium","occasions":["smart_casual","casual","work"],"fabric":"cotton","description":"Stone stretch slim-fit chinos"}',
      usageMetadata: { promptTokenCount: 1180, candidatesTokenCount: 88, thoughtsTokenCount: 140, totalTokenCount: 1408 },
    },
  },
  bad: {
    /** Cut off mid-reply (e.g. hit the output limit). */
    truncated: {
      text: '{"category":"top","subcategory":"t_shirt","colours":["na',
      usageMetadata: usage,
    },
    /** Parses, but the subcategory belongs to another category and a colour isn't in the palette. */
    inventedVocabulary: {
      text: '{"category":"top","subcategory":"skirt","colours":["dusty heather"],"pattern":"plain","formality":2,"seasons":["winter"],"warmth":"warm","occasions":["casual"],"fabric":"wool","description":"Heather skirt"}',
      usageMetadata: usage,
    },
    /** No text at all (e.g. the reply was blocked). */
    empty: { text: "", usageMetadata: { promptTokenCount: 1712 } },
  },
} satisfies { good: Record<string, RecordedReply>; textOnly: Record<string, RecordedReply>; bad: Record<string, RecordedReply> };
