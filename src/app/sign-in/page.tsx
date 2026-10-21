import type { Metadata } from "next";
import { isMockMode } from "@/lib/env";
import { safeReturnPath } from "@/lib/auth/redirect";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

// Minimal working sign-in so auth can be checked end to end. wardrobe-ui
// owns the final design and may restyle it freely (keep the API calls).
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in to GladRags</h1>
        <p className="text-muted-foreground">We&apos;ll email you a link and a code. No password needed.</p>
      </div>
      {error === "link" && (
        <p role="alert" className="rounded-md bg-muted p-3 text-sm">
          That sign-in link didn&apos;t work or has expired. Ask for a new one below.
        </p>
      )}
      {isMockMode() && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Mock mode: no email is sent and any 6-digit code works.
        </p>
      )}
      <SignInForm next={safeReturnPath(next)} />
    </main>
  );
}
