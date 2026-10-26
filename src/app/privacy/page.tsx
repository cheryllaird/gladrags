import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { PRIVACY_BLOCKS, PRIVACY_TITLE, type PrivacyBlock } from "./content";

export const metadata: Metadata = { title: "Privacy" };

/**
 * The tester privacy note. Public (src/proxy.ts lets signed-out visitors
 * see it) and shown without the bottom nav, since it's linked from the
 * sign-in page as well as the Account sheet. Back goes to "/", which is the
 * wardrobe when signed in and sign-in otherwise.
 */
export default function PrivacyPage() {
  return (
    <>
      <PageHeader title="Privacy" backHref="/" backLabel="Back to GladRags" />
      <PageBody className="pb-[max(env(safe-area-inset-bottom),2rem)]">
        <article className="space-y-4 text-base leading-relaxed">
          <h2 className="text-2xl leading-tight font-semibold tracking-tight text-balance">{PRIVACY_TITLE}</h2>
          {PRIVACY_BLOCKS.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </article>
      </PageBody>
    </>
  );
}

function Block({ block }: { block: PrivacyBlock }) {
  switch (block.kind) {
    case "heading":
      return <h3 className="pt-2 text-lg font-semibold tracking-tight">{block.text}</h3>;
    case "paragraph":
      return <p>{block.text}</p>;
    case "list":
      return (
        <ul className="marker:text-muted-foreground ml-5 list-disc space-y-3">
          {block.items.map((item, index) => (
            <li key={index} className="pl-1">
              <strong className="font-semibold">{item.lead}</strong> {item.text}
            </li>
          ))}
        </ul>
      );
  }
}
