"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiErrorSchema, MagicLinkResponseSchema, VerifyCodeResponseSchema } from "@/contracts";

type Step = { kind: "email" } | { kind: "code"; email: string };

async function postJson(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json();
    if (res.ok) return { ok: true, data };
    const error = ApiErrorSchema.safeParse(data);
    return { ok: false, message: error.success ? error.data.error.message : "Something went wrong. Try again." };
  } catch {
    return { ok: false, message: "Couldn't reach GladRags. Check your connection." };
  }
}

export function SignInForm({ next }: { next: string }) {
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestLink(formData: FormData) {
    setBusy(true);
    setMessage(null);
    const email = String(formData.get("email") ?? "");
    const result = await postJson("/api/auth/magic-link", { email, next });
    setBusy(false);
    if (result.ok && MagicLinkResponseSchema.safeParse(result.data).success) {
      setStep({ kind: "code", email });
    } else if (!result.ok) {
      setMessage(result.message);
    }
  }

  async function verifyCode(formData: FormData) {
    if (step.kind !== "code") return;
    setBusy(true);
    setMessage(null);
    const result = await postJson("/api/auth/verify-code", {
      email: step.email,
      code: String(formData.get("code") ?? ""),
      next,
    });
    setBusy(false);
    const parsed = result.ok ? VerifyCodeResponseSchema.safeParse(result.data) : null;
    if (parsed?.success) {
      window.location.assign(parsed.data.next);
    } else {
      setMessage(result.ok ? "Something went wrong. Try again." : result.message);
    }
  }

  return (
    <div className="space-y-4">
      {step.kind === "email" ? (
        <form action={requestLink} className="space-y-3">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      ) : (
        <form action={verifyCode} className="space-y-3">
          <p className="text-sm">
            Check <strong>{step.email}</strong>. Tap the link in the email, or type the code here
            (best if you&apos;re using GladRags from your home screen).
          </p>
          <label htmlFor="code" className="text-sm font-medium">
            Code from the email
          </label>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" required />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Checking…" : "Sign in"}
          </Button>
          <Button type="button" variant="link" className="w-full" onClick={() => setStep({ kind: "email" })}>
            Use a different email
          </Button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
