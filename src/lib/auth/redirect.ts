import { ReturnPathSchema } from "@/contracts";

/** A safe same-site path from an untrusted `next` value; "/" if it isn't one. */
export function safeReturnPath(next: string | null | undefined): string {
  const parsed = ReturnPathSchema.safeParse(next);
  return parsed.success ? parsed.data : "/";
}
