import Link from "next/link";
import { Button } from "@/components/ui/button";

// Placeholder home. The real screens belong to wardrobe-ui and outfit-ui.
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">GladRags</h1>
        <p className="text-muted-foreground">
          Your wardrobe, tagged, with outfit ideas for wherever you&apos;re going.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        The wardrobe and outfit screens are being built. This page is a placeholder.
      </p>
      <form action="/api/auth/sign-out" method="post">
        <Button type="submit" variant="outline" className="w-full">
          Sign out
        </Button>
      </form>
      <Link href="/sign-in" className="text-sm underline underline-offset-4">
        Sign-in page
      </Link>
    </main>
  );
}
