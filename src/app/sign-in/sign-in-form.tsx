"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MagicLinkResponseSchema, VerifyCodeResponseSchema } from "@/contracts";
import { ApiClientError, apiRequest } from "@/lib/client/api";

type Step = { kind: "email" } | { kind: "code"; email: string };

// Here `unauthorized` means a wrong or expired code, not a lost session.
const NO_REDIRECT = { redirectOnUnauthorized: false };

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function messageFor(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Something went wrong. Try again.";
}

export function SignInForm({ next }: { next: string }) {
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestLink(formData: FormData) {
    setBusy(true);
    setMessage(null);
    const email = String(formData.get("email") ?? "");
    try {
      await apiRequest(MagicLinkResponseSchema, "/api/auth/magic-link", postJson({ email, next }), NO_REDIRECT);
      setStep({ kind: "code", email });
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(formData: FormData) {
    if (step.kind !== "code") return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiRequest(
        VerifyCodeResponseSchema,
        "/api/auth/verify-code",
        postJson({ email: step.email, code: String(formData.get("code") ?? ""), next }),
        NO_REDIRECT,
      );
      window.location.assign(result.next);
    } catch (error) {
      setMessage(messageFor(error));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {step.kind === "email" ? (
        <form action={requestLink} className="space-y-3">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            required
          />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      ) : (
        <form action={verifyCode} className="space-y-3">
          <p className="text-sm">
            Check <strong>{step.email}</strong>. Tap the link in the email, or type the code here (best if
            you&apos;re using GladRags from your home screen).
          </p>
          <Label htmlFor="code">Code from the email</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6,10}"
            className="text-center font-mono text-lg tracking-[0.3em]"
            required
          />
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? "Checking…" : "Sign in"}
          </Button>
          <Button
            type="button"
            variant="link"
            className="w-full"
            onClick={() => {
              setMessage(null);
              setStep({ kind: "email" });
            }}
          >
            Use a different email
          </Button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-destructive text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
