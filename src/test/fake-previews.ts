/**
 * Test-only: FakeSupabase plus the round 2 preview pieces the preview route
 * uses: the claim_outfit_preview and finish_outfit_preview database
 * functions (a JavaScript copy of migration 8's logic, without the locks),
 * the release trigger, and storage upload and remove. Errors can be queued
 * per function (e.g. a 40P01 deadlock) to test the retry.
 *
 * The SQL itself is tested against Postgres by `pnpm db:verify`; this only
 * has to behave the same for the route's tests.
 */
import { PREVIEW_FAILED_RETRY_SECONDS, PREVIEW_PENDING_STALE_SECONDS } from "@/contracts";
import { FakeSupabase } from "./fake-supabase";

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

export class FakePreviewSupabase extends FakeSupabase {
  /** Queued errors per function name, used (and removed) one per call. */
  readonly rpcErrors = new Map<string, { message: string; code?: string }[]>();
  readonly rpcCalls: { fn: string; args: Row }[] = [];
  readonly uploads: { bucket: string; key: string; mimeType: string }[] = [];
  readonly removed: { bucket: string; keys: string[] }[] = [];
  now = () => Date.now();

  constructor() {
    super();
    this.tables.outfit_previews = [];
    this.tables.user_settings = [];
    const from = this.storage.from;
    (this.storage as { from: unknown }).from = (bucket: string) => ({
      ...from(bucket),
      upload: async (key: string, data: Uint8Array, options: { contentType: string }) => {
        this.objects.set(`${bucket}/${key}`, data);
        this.uploads.push({ bucket, key, mimeType: options.contentType });
        return { data: { path: key }, error: null };
      },
      remove: async (keys: string[]) => {
        for (const key of keys) this.objects.delete(`${bucket}/${key}`);
        this.removed.push({ bucket, keys });
        return { data: [], error: null };
      },
    });
  }

  get previews(): Row[] {
    return this.tables.outfit_previews!;
  }

  get outfits(): Row[] {
    return this.tables.outfits!;
  }

  async rpc(fn: string, args: Row): Promise<RpcResult> {
    this.rpcCalls.push({ fn, args });
    const queued = this.rpcErrors.get(fn)?.shift();
    if (queued) return { data: null, error: queued };
    if (fn === "claim_outfit_preview") return { data: this.claim(args), error: null };
    if (fn === "finish_outfit_preview") return { data: this.finish(args), error: null };
    return { data: null, error: { message: `no fake for ${fn}` } };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private stands(p: Row): boolean {
    const age = (this.now() - Date.parse(String(p.attempted_at))) / 1000;
    switch (p.status) {
      case "ready":
        return true;
      case "pending":
        return age < PREVIEW_PENDING_STALE_SECONDS;
      case "failed":
        return p.failure_reason === "blocked" || p.failure_reason === "invalid_image" || age < PREVIEW_FAILED_RETRY_SECONDS;
      default:
        return false;
    }
  }

  private preview(id: unknown): Row | undefined {
    return id ? this.previews.find((p) => p.id === id) : undefined;
  }

  /** release_outfit_preview: delete an unused, non-failed preview; its image key. */
  private release(id: unknown): string | null {
    const p = this.preview(id);
    if (!p || p.status === "failed") return null;
    if (this.outfits.some((o) => o.preview_id === id || o.pending_preview_id === id)) return null;
    this.previews.splice(this.previews.indexOf(p), 1);
    return (p.image_key as string | null) ?? null;
  }

  /** An outfits update, with the release trigger. */
  private setOutfit(o: Row, patch: Row): void {
    const old = { preview_id: o.preview_id, pending_preview_id: o.pending_preview_id };
    if ("preview_id" in patch && patch.preview_id !== o.preview_id) o.preview_outdated = false;
    Object.assign(o, patch);
    if (old.preview_id !== o.preview_id && old.preview_id !== o.pending_preview_id) this.release(old.preview_id);
    if (old.pending_preview_id !== o.pending_preview_id && old.pending_preview_id !== o.preview_id && old.pending_preview_id !== old.preview_id) {
      this.release(old.pending_preview_id);
    }
  }

  private claim(a: Row): Row {
    const o = this.outfits.find((r) => r.id === a.p_outfit && r.user_id === a.p_user);
    if (!o) return { ok: false, reason: "not_found" };
    const linked = this.preview(o.preview_id);
    const result = (action: string, p: Row, refreshing: boolean, released: string | null = null) => ({
      ok: true,
      action,
      preview_id: p.id,
      status: p.status,
      refreshing,
      released_image_key: released,
    });

    if (linked && linked.cache_key === a.p_cache_key && this.stands(linked)) {
      if (o.preview_outdated || o.pending_preview_id) this.setOutfit(o, { preview_outdated: false, pending_preview_id: null });
      return result("existing", linked, false);
    }
    if (!a.p_refresh && linked && this.stands(linked)) return result("existing", linked, o.pending_preview_id != null);

    let keepOld = Boolean(a.p_refresh) && linked?.status === "ready";
    let r = this.previews.find((p) => p.user_id === a.p_user && p.cache_key === a.p_cache_key);
    let action: string;
    const slots = ((o.gaps as Row[]) ?? []).map((g) => g.category);
    if (r && (r.status === "ready" || r.status === "failed") && this.stands(r)) {
      if (r.status === "failed" && keepOld) {
        if (o.pending_preview_id) this.setOutfit(o, { pending_preview_id: null });
        return result("unavailable", r, false);
      }
      action = "reused";
      keepOld = false;
    } else if (r && r.status === "pending" && this.stands(r)) {
      action = "wait";
    } else if (r) {
      Object.assign(r, { status: "pending", failure_reason: null, image_key: null, preset_id: a.p_preset_id, attempted_at: this.iso(), item_ids: o.item_ids, suggested_slots: slots });
      action = "generate";
    } else {
      r = {
        id: crypto.randomUUID(),
        user_id: a.p_user,
        cache_key: a.p_cache_key,
        preset_id: a.p_preset_id,
        item_ids: o.item_ids,
        suggested_slots: slots,
        status: "pending",
        image_key: null,
        failure_reason: null,
        attempted_at: this.iso(),
        created_at: this.iso(),
        updated_at: this.iso(),
      };
      this.previews.push(r);
      action = "generate";
    }

    let released: string | null = null;
    if (keepOld) {
      if (o.pending_preview_id !== r.id) this.setOutfit(o, { pending_preview_id: r.id });
    } else if (o.preview_id !== r.id || o.pending_preview_id) {
      const linkedId = o.preview_id;
      this.setOutfit(o, { preview_id: r.id, pending_preview_id: null });
      if (linkedId && linkedId !== r.id && !this.preview(linkedId)) released = (linked?.image_key as string | null) ?? null;
    }
    return result(action, r, keepOld, released);
  }

  private finish(a: Row): Row {
    const p = this.previews.find((r) => r.id === a.p_preview && r.user_id === a.p_user);
    if (!p || p.status !== "pending") return { ok: false, released_image_keys: [] };
    const ready = a.p_status === "ready";
    Object.assign(p, { status: a.p_status, image_key: ready ? a.p_image_key : null, failure_reason: ready ? null : a.p_failure_reason, updated_at: this.iso() });
    const released: string[] = [];
    for (const o of this.outfits.filter((r) => r.user_id === a.p_user && r.pending_preview_id === p.id)) {
      if (ready) {
        const old = this.preview(o.preview_id);
        this.setOutfit(o, { preview_id: p.id, pending_preview_id: null });
        if (old && old.image_key && !this.preview(old.id)) released.push(old.image_key as string);
      } else {
        this.setOutfit(o, { pending_preview_id: null });
      }
    }
    return { ok: true, released_image_keys: released };
  }
}
