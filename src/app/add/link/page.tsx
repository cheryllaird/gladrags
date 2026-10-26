import type { Metadata } from "next";
import { linkFromShare } from "@/lib/client/add-item";
import { AddLinkFlow } from "./add-link-flow";

export const metadata: Metadata = { title: "Add by link" };

/**
 * Add by link. Also the PWA share target (src/app/manifest.ts): Android
 * opens /add/link?url=… or ?text=… when a product page is shared to the
 * installed app, and the import starts straight away.
 */
export default async function AddLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const initialUrl = linkFromShare({ url: first(params.url), text: first(params.text) });
  return <AddLinkFlow initialUrl={initialUrl} />;
}
