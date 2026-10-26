/**
 * The tester privacy note shown at /privacy (spec: Privacy and security,
 * "A one-page privacy note for testers").
 *
 * docs/PRIVACY.md is the source of the text, and this mirrors it block for
 * block: a heading, a paragraph, or a bulleted list whose items start with
 * a bold lead ("Your phone."). It's held here as plain data rather than
 * parsed from the Markdown, so the page needs no Markdown library.
 * content.test.ts fails if the two drift apart. ("For Cheryl" notes in the
 * Markdown aren't shown.)
 */

export type PrivacyBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: { lead: string; text: string }[] };

export const PRIVACY_TITLE = "GladRags: how your photos and data are handled";

export const PRIVACY_BLOCKS: PrivacyBlock[] = [
  {
    kind: "paragraph",
    text: "GladRags is a small test app. Treat it as a prototype. Here's exactly where your data goes.",
  },
  { kind: "heading", text: "What we store" },
  {
    kind: "paragraph",
    text: "Your email address, the photos and product links you add, the cut-out images, the tags, the outfits you get, save or reject, and any feedback you type. We also keep simple usage counts (how many items and outfit requests you make each day) to keep costs down.",
  },
  { kind: "heading", text: "Who sees your images" },
  {
    kind: "list",
    items: [
      {
        lead: "Your phone.",
        text: "Background removal runs on your own phone. The photo isn't sent anywhere for this step.",
      },
      {
        lead: "Supabase",
        text: "(database, sign-in and image storage, hosted in [region]). Your photos are stored in private storage. They're only shown to you, through links that expire after an hour.",
      },
      {
        lead: "Google Gemini",
        text: "(paid tier). To tag each item and suggest outfits, the app sends Gemini a small copy of the item's picture, plus your style and guidance text. On the paid tier, Google doesn't use this to improve its products. It may keep it for a limited time to check for abuse, as its terms describe.",
      },
      {
        lead: "Vercel",
        text: "(hosts the app). Your uploads pass through Vercel's servers on the way to storage and aren't kept there. Vercel keeps short-lived request logs, which can include links you paste and search terms.",
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
  { kind: "heading", text: "Before you take photos" },
  {
    kind: "paragraph",
    text: "Photograph only the clothes, and check what's in the background. Location data (EXIF and GPS) is removed from every photo before it's stored.",
  },
  { kind: "heading", text: "Deleting" },
  {
    kind: "paragraph",
    text: "You can delete any item, and its photos go with it. \"Delete my account\" (Account, then Delete my account) removes all your photos, items, outfits and feedback, plus your sign-in account. We keep only anonymous daily usage counts, with no link to you, so the month's AI costs still add up. Photos you uploaded but never saved are deleted automatically within a day.",
  },
  { kind: "heading", text: "Questions or a deletion request" },
  { kind: "paragraph", text: "Contact Cheryl at [contact address]." },
];

/**
 * The note as plain text, one entry per title, heading, paragraph or list
 * item, in order. What content.test.ts compares with docs/PRIVACY.md.
 */
export function privacyPlainText(): string[] {
  return [
    PRIVACY_TITLE,
    ...PRIVACY_BLOCKS.flatMap((block) =>
      block.kind === "list" ? block.items.map((item) => `${item.lead} ${item.text}`) : [block.text],
    ),
  ];
}
