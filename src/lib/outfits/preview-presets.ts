/**
 * Round 2: the preset figures' pictures, shipped in public/presets and read
 * from disk by the preview route. next.config.ts includes them in the
 * route's serverless bundle (outputFileTracingIncludes), since nothing
 * imports them. Server only.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MODEL_PRESETS_BY_ID } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { sniffImageType } from "@/lib/images/server";
import type { PresetImageSource } from "./preview";

export class FilePresetImageSource implements PresetImageSource {
  private readonly cache = new Map<string, ImageInput>();

  constructor(private readonly publicDir: string = join(process.cwd(), "public")) {}

  async load(presetId: string): Promise<ImageInput> {
    // Only known IDs reach the file system (they're also the file names).
    const preset = MODEL_PRESETS_BY_ID.get(presetId);
    if (!preset) throw new Error(`Unknown model preset ${presetId}`);
    const cached = this.cache.get(presetId);
    if (cached) return cached;
    const data = new Uint8Array(await readFile(join(this.publicDir, preset.imagePath)));
    const mimeType = sniffImageType(data);
    if (!mimeType) throw new Error(`The picture for preset ${presetId} isn't JPEG, PNG or WebP`);
    const image = { data, mimeType };
    this.cache.set(presetId, image);
    return image;
  }
}
