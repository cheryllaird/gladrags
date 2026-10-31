/**
 * The email_imports table (CONTRACTS.md section 2) and the forwarding-token
 * lookup. One row per forwarded email that reached a user's token; it
 * never holds the email (no sender, recipients, subject or body).
 *
 * Two sides:
 * - EmailImportRepository: the webhook's writes and the token lookup. The
 *   webhook has no session, so the Supabase version uses the admin client
 *   and filters by user ID itself (email_imports and user_settings tokens
 *   are server-written).
 * - EmailImportReader: GET /api/email-imports, with the signed-in user's
 *   client (RLS: own rows, read-only).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  EmailImportRowSchema,
  EmailImportSchema,
  ForwardingTokenSchema,
  type EmailImport,
  type EmailImportError,
  type EmailImportRow,
  type EmailImportStatus,
} from "@/contracts";

export interface ForwardingUser {
  userId: string;
  /** The user's sign-in address (lower-cased), which forwarded emails must come from. */
  email: string;
}

export interface EmailImportOutcome {
  status: Exclude<EmailImportStatus, "processing">;
  shopName: string | null;
  orderDate: string | null;
  itemCount: number;
  skippedCount: number;
  error: EmailImportError | null;
}

export interface EmailImportRepository {
  /** The user a forwarding token belongs to, or null. */
  findUserByToken(token: string): Promise<ForwardingUser | null>;
  /**
   * Record a newly arrived email as `processing`. Null if this user already
   * has one with this message hash (a redelivered webhook): one statement,
   * so two deliveries at once can't both start.
   */
  start(userId: string, messageHash: string, receivedAt: string): Promise<string | null>;
  /** Set the final status, counts, shop name and order date. */
  finish(id: string, outcome: EmailImportOutcome): Promise<void>;
  /**
   * Delete a row that `start` made, when our side failed before the email
   * was judged, so the service's retry is processed rather than skipped.
   */
  abandon(id: string): Promise<void>;
}

export interface EmailImportReader {
  /** The user's most recent imports, newest first. */
  list(userId: string, limit: number): Promise<EmailImport[]>;
}

/**
 * An import still `processing` after this long was cut off (the function
 * was stopped, or crashed, part-way). It's shown as failed (`internal`).
 */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

/** A row as the user sees it. A long-stuck `processing` row reads as failed. */
export function rowToEmailImport(row: EmailImportRow, now: Date): EmailImport {
  const stale = row.status === "processing" && now.getTime() - new Date(row.created_at).getTime() > STALE_PROCESSING_MS;
  return EmailImportSchema.parse({
    id: row.id,
    receivedAt: new Date(row.received_at).toISOString(),
    shopName: row.shop_name,
    orderDate: row.order_date,
    status: stale ? "failed" : row.status,
    itemCount: row.item_count,
    skippedCount: row.skipped_count,
    error: stale ? (row.error ?? "internal") : row.error,
  });
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

const ROW_COLUMNS = "id, user_id, message_hash, received_at, shop_name, order_date, status, item_count, skipped_count, error, created_at";

export class SupabaseEmailImportRepository implements EmailImportRepository {
  constructor(private readonly admin: SupabaseClient) {}

  async findUserByToken(token: string): Promise<ForwardingUser | null> {
    if (!ForwardingTokenSchema.safeParse(token).success) return null;
    const settings = await this.admin.from("user_settings").select("user_id").eq("forwarding_token", token).maybeSingle();
    if (settings.error) throw new Error(`Couldn't look up the forwarding address: ${settings.error.message}`);
    const userId = z.object({ user_id: z.uuid() }).nullable().parse(settings.data)?.user_id;
    if (!userId) return null;
    const user = await this.admin.from("users").select("email").eq("id", userId).maybeSingle();
    if (user.error) throw new Error(`Couldn't read the user: ${user.error.message}`);
    const email = z.object({ email: z.string() }).nullable().parse(user.data)?.email;
    return email ? { userId, email: email.trim().toLowerCase() } : null;
  }

  async start(userId: string, messageHash: string, receivedAt: string): Promise<string | null> {
    const { data, error } = await this.admin
      .from("email_imports")
      .insert({ user_id: userId, message_hash: messageHash, received_at: receivedAt, status: "processing" })
      .select("id")
      .single();
    if (error?.code === UNIQUE_VIOLATION) return null;
    if (error) throw new Error(`Couldn't record the email: ${error.message}`);
    return z.object({ id: z.uuid() }).parse(data).id;
  }

  async finish(id: string, outcome: EmailImportOutcome): Promise<void> {
    const { error } = await this.admin
      .from("email_imports")
      .update({
        status: outcome.status,
        shop_name: outcome.shopName,
        order_date: outcome.orderDate,
        item_count: outcome.itemCount,
        skipped_count: outcome.skippedCount,
        error: outcome.error,
      })
      .eq("id", id);
    if (error) throw new Error(`Couldn't update the email import: ${error.message}`);
  }

  async abandon(id: string): Promise<void> {
    const { error } = await this.admin.from("email_imports").delete().eq("id", id).eq("status", "processing");
    if (error) throw new Error(`Couldn't remove the email import: ${error.message}`);
  }
}

export class SupabaseEmailImportReader implements EmailImportReader {
  constructor(
    private readonly db: SupabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string, limit: number): Promise<EmailImport[]> {
    const { data, error } = await this.db
      .from("email_imports")
      .select(ROW_COLUMNS)
      .eq("user_id", userId)
      .order("received_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Couldn't list email imports: ${error.message}`);
    const now = this.now();
    return z.array(EmailImportRowSchema).parse(data ?? []).map((row) => rowToEmailImport(row, now));
  }
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

/** For tests. Same rules as the table: one row per user and message hash; failed needs an error. */
export class InMemoryEmailImportRepository implements EmailImportRepository, EmailImportReader {
  readonly rows = new Map<string, EmailImportRow>();
  /** token -> user */
  readonly tokens = new Map<string, ForwardingUser>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async findUserByToken(token: string): Promise<ForwardingUser | null> {
    return this.tokens.get(token) ?? null;
  }

  async start(userId: string, messageHash: string, receivedAt: string): Promise<string | null> {
    for (const row of this.rows.values()) {
      if (row.user_id === userId && row.message_hash === messageHash) return null;
    }
    const row = EmailImportRowSchema.parse({
      id: crypto.randomUUID(),
      user_id: userId,
      message_hash: messageHash,
      received_at: receivedAt,
      shop_name: null,
      order_date: null,
      status: "processing",
      item_count: 0,
      skipped_count: 0,
      error: null,
      created_at: new Date(this.now().getTime() + this.rows.size).toISOString(),
    });
    this.rows.set(row.id, row);
    return row.id;
  }

  async finish(id: string, outcome: EmailImportOutcome): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("Couldn't update the email import: no such row");
    if (outcome.status === "failed" && outcome.error === null) throw new Error("Couldn't update the email import: failed needs an error");
    if (outcome.shopName !== null && (outcome.shopName.length < 1 || outcome.shopName.length > 80)) throw new Error("shop_name check");
    Object.assign(row, {
      status: outcome.status,
      shop_name: outcome.shopName,
      order_date: outcome.orderDate,
      item_count: outcome.itemCount,
      skipped_count: outcome.skippedCount,
      error: outcome.error,
    });
  }

  async abandon(id: string): Promise<void> {
    if (this.rows.get(id)?.status === "processing") this.rows.delete(id);
  }

  async list(userId: string, limit: number): Promise<EmailImport[]> {
    const now = this.now();
    return [...this.rows.values()]
      .filter((row) => row.user_id === userId)
      .sort((a, b) => b.received_at.localeCompare(a.received_at))
      .slice(0, limit)
      .map((row) => rowToEmailImport(row, now));
  }
}
