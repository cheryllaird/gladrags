import type { Metadata } from "next";
import { getSessionUser } from "@/lib/auth/session";
import { linkFromShare } from "@/lib/client/add-item";
import { AddLinkFlow } from "./add-link-flow";

export const metadata: Metadata = { title: "Add by link" };

/**
 * Add by link. Also the PWA share target (src/app/manifest.ts): Android
 * opens /add/link?url=… or ?text=… when a product page is shared to the
 * installed app. The link is filled in, but the import only starts when the
 * user taps "Import this link": a plain GET must never make the server
 * fetch a URL, or any site could link here and do it in the user's session.
 */
export default async function AddLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const sharedUrl = linkFromShare({ url: first(params.url), text: first(params.text) });
  // Whose add this is, for a draft kept when a session expires (pending-add.ts).
  const user = await getSessionUser().catch(() => null);
  return <AddLinkFlow sharedUrl={sharedUrl} userId={user?.id ?? null} />;
}
