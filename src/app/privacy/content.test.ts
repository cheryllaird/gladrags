/**
 * The /privacy page must say exactly what docs/PRIVACY.md says, so the two
 * can't drift apart. Markdown markup is ignored, and so are blockquotes
 * (the "For Cheryl" notes, which aren't for testers).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRIVACY_BLOCKS, privacyPlainText } from "./content";

/** docs/PRIVACY.md as plain text: one entry per heading, paragraph or list item, in order. */
function markdownPlainText(markdown: string): string[] {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push(paragraph.join(" "));
    paragraph = [];
  };
  const inline = (text: string) =>
    text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
      .replace(/\*\*|__|`/g, "") // bold, inline code
      .replace(/\s+/g, " ")
      .trim();

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(">")) {
      endParagraph();
    } else if (/^#{1,6}\s/.test(trimmed)) {
      endParagraph();
      blocks.push(inline(trimmed.replace(/^#{1,6}\s+/, "")));
    } else if (/^[-*]\s/.test(trimmed)) {
      endParagraph();
      blocks.push(inline(trimmed.replace(/^[-*]\s+/, "")));
    } else {
      paragraph.push(inline(trimmed));
    }
  }
  endParagraph();
  return blocks;
}

const MARKDOWN = readFileSync(new URL("../../../docs/PRIVACY.md", import.meta.url), "utf8");

describe("privacy note", () => {
  it("matches docs/PRIVACY.md, block for block", () => {
    expect(privacyPlainText()).toEqual(markdownPlainText(MARKDOWN));
  });

  it("leaves out the For Cheryl notes", () => {
    expect(MARKDOWN).toContain("For Cheryl");
    expect(privacyPlainText().join(" ")).not.toMatch(/For Cheryl/);
  });

  it("names Supabase's hosting region", () => {
    const supabase = PRIVACY_BLOCKS.flatMap((b) => (b.kind === "list" ? b.items : [])).find((i) => i.lead === "Supabase");
    expect(`${supabase?.lead} ${supabase?.text}`).toMatch(
      /^Supabase \(database, sign-in and image storage, hosted in \[region\]\)\./,
    );
  });
});

describe("markdownPlainText (the comparison itself)", () => {
  it("drops markup and blockquotes, and joins wrapped paragraph lines", () => {
    const md = "# Title\n\n> **Note:** hidden\n> still hidden\n\nOne\nparagraph.\n\n- **Lead.** item [link](https://x.test)\n";
    expect(markdownPlainText(md)).toEqual(["Title", "One paragraph.", "Lead. item link"]);
  });

  it("would catch a changed word", () => {
    expect(markdownPlainText(MARKDOWN.replace("an hour", "a day"))).not.toEqual(privacyPlainText());
  });
});
