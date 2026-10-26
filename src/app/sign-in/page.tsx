import { ShirtIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { isMockMode } from "@/lib/env";
import { safeReturnPath } from "@/lib/auth/redirect";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; reason?: string }>;
}) {
  const { next, error, reason } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-[max(env(safe-area-inset-top),3rem)] pb-[max(env(safe-area-inset-bottom),2rem)]">
      <div className="flex flex-1 flex-col justify-center gap-8">
        <div className="space-y-4">
          <div className="bg-primary text-primary-foreground flex size-14 items-center justify-center rounded-2xl" aria-hidden="true">
            <ShirtIcon className="size-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Sign in to GladRags</h1>
            <p className="text-muted-foreground">
              Your wardrobe, tagged, with outfit ideas for wherever you&apos;re going. We&apos;ll email you a link and a
              code. No password needed.
            </p>
          </div>
        </div>
        {reason === "expired" && error !== "link" && (
          <p role="status" className="bg-muted rounded-md p-3 text-sm">
            You&apos;ve been signed out. Sign in again and we&apos;ll take you back to where you were.
          </p>
        )}
        {error === "link" && (
          <p role="alert" className="bg-muted rounded-md p-3 text-sm">
            That sign-in link didn&apos;t work or has expired. Ask for a new one below.
          </p>
        )}
        <SignInForm next={safeReturnPath(next)} />
      </div>
      {isMockMode() && (
        <p className="text-muted-foreground mt-8 rounded-md border border-dashed p-3 text-sm">
          Mock mode: no email is sent and any 6-digit code works.
        </p>
      )}
      <div className="mt-6 flex flex-col items-center gap-1 text-center">
        <p className="text-muted-foreground text-xs">GladRags is invite-only while we test it.</p>
        <Link
          href="/privacy"
          className="inline-flex min-h-11 items-center px-2 text-sm font-medium underline underline-offset-4"
        >
          How your photos are handled
        </Link>
      </div>
    </main>
  );
}
