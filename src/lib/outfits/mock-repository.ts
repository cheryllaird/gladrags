/**
 * OutfitRepository on the in-memory mock store, for mock mode. Mock mode
 * has a single user, so userId is ignored.
 */
import type { FeedbackKind, Outfit, OutfitStatus } from "@/contracts";
import * as mock from "@/lib/mocks/store";
import { OUTFIT_LIST_LIMIT, type NewOutfit, type OutfitRepository } from "./repository";
import type { WardrobeEntry } from "./types";

export class MockOutfitRepository implements OutfitRepository {
  async listWardrobe(): Promise<WardrobeEntry[]> {
    return mock.listItems().map((item) => ({
      id: item.id,
      tags: item.tags,
      // Mock pictures are public placeholder files; thumbnails are placeholders too.
      image: { bucket: item.cutoutUrl ? "cutouts" : "originals", key: item.cutoutUrl ?? item.originalUrl },
    }));
  }

  async listOutfits(_userId: string, status?: OutfitStatus): Promise<Outfit[]> {
    return mock.listOutfits(status).slice(0, OUTFIT_LIST_LIMIT);
  }

  async getOutfit(_userId: string, outfitId: string): Promise<Outfit | null> {
    return mock.getOutfit(outfitId);
  }

  async insertOutfits(_userId: string, outfits: readonly NewOutfit[]): Promise<Outfit[]> {
    const createdAt = new Date().toISOString();
    return outfits.map((o) => {
      const items = o.itemIds.map((id) => {
        const item = mock.getItem(id);
        if (!item) throw new Error(`Mock outfit uses unknown item ${id}`);
        return item;
      });
      return mock.insertOutfit({
        id: crypto.randomUUID(),
        request: o.request,
        name: o.name,
        reason: o.reason,
        itemIds: o.itemIds,
        items,
        gaps: [],
        status: "suggested",
        parentOutfitId: o.parentOutfitId,
        createdAt,
      });
    });
  }

  async setStatus(_userId: string, outfitId: string, status: OutfitStatus): Promise<Outfit | null> {
    return mock.setOutfitStatus(outfitId, status);
  }

  async addFeedback(_userId: string, outfitId: string, kind: FeedbackKind, detail: string | null): Promise<void> {
    mock.addOutfitFeedback({ outfitId, kind, detail, createdAt: new Date().toISOString() });
  }

  async listRejectedItemIds(_userId: string, limit: number): Promise<string[][]> {
    return mock
      .listOutfits("rejected")
      .slice(0, limit)
      .map((o) => o.itemIds);
  }
}
