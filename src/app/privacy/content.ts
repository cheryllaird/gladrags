/**
 * The tester privacy note shown at /privacy (spec: Privacy and security,
 * "A one-page privacy note for testers").
 *
 * Keep this in sync with docs/PRIVACY.md, which is the source of the text.
 * It's held here as plain data rather than parsed from the Markdown, so the
 * page needs no Markdown library and the wording is easy to find and edit.
 *
 * A block is a paragraph or a bulleted list. `lead` is an optional bold
 * opening ("What we store:"), followed by the rest of the text.
 */

export interface PrivacyParagraph {
  kind: "paragraph";
  lead?: string;
  text: string;
}

export interface PrivacyList {
  kind: "list";
  items: { lead?: string; text: string }[];
}

export type PrivacyBlock = PrivacyParagraph | PrivacyList;

export const PRIVACY_TITLE = "GladRags: how your photos and data are handled";

export const PRIVACY_BLOCKS: PrivacyBlock[] = [
  {
    kind: "paragraph",
    text: "GladRags is a small test app. Treat it as a prototype. Here's exactly where your data goes.",
  },
  {
    kind: "paragraph",
    lead: "What we store:",
    text: "your email address, the photos and product links you add, the cut-out images, the tags, the outfits you get, save or reject, and any feedback you type. We also keep simple usage counts (how many items and outfit requests you make each day) to keep costs down.",
  },
  { kind: "paragraph", lead: "Who sees your images:", text: "" },
  {
    kind: "list",
    items: [
      {
        lead: "Your phone.",
        text: "Background removal runs on your own phone. The photo isn't sent anywhere for this step.",
      },
      {
        lead: "Supabase (database, sign-in and image storage).",
        text: "Your photos are stored in private storage. They're only shown to you, through links that expire after an hour.",
      },
      {
        lead: "Google Gemini (paid tier).",
        text: "To tag each item and suggest outfits, the app sends Gemini a small copy of the item's picture, plus your style and guidance text. On the paid tier, Google doesn't use this to improve its products. It may keep it for a limited time to check for abuse, as its terms describe.",
      },
      {
        lead: "Vercel (hosts the app).",
        text: "Your uploads pass through Vercel's servers on the way to storage and aren't kept there. Vercel keeps short-lived request logs, which can include links you paste and search terms.",
      },
      {
        lead: "Shops.",
        text: "When you add an item by link, our server (not your phone) visits that page and downloads the product picture. The shop sees a request from GladRags, not from you.",
      },
    ],
  },
  {
    kind: "paragraph",
    text: "Nobody else gets your images. There are no ads and no analytics, and your data isn't sold or shared.",
  },
  {
    kind: "paragraph",
    lead: "Before you take photos:",
    text: "photograph only the clothes, and check what's in the background. Location data (EXIF and GPS) is removed from every photo before it's stored.",
  },
  {
    kind: "paragraph",
    lead: "Deleting:",
    text: "you can delete any item, and its photos go with it. \"Delete my account\" (Account, then Delete my account) removes all your photos, items, outfits and feedback, plus your sign-in account. We keep only anonymous daily usage counts, with no link to you, so the month's AI costs still add up. Photos you uploaded but never saved are deleted automatically within a day.",
  },
  {
    kind: "paragraph",
    lead: "Questions or a deletion request:",
    text: "contact Cheryl at [contact address].",
  },
];
