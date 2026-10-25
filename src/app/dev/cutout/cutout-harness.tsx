"use client";

import { useEffect, useRef, useState } from "react";
import {
  ImagePreparationError,
  OnnxBackgroundRemover,
  buildPhotoUploadForm,
  getBackgroundRemover,
  isModelCached,
  prepareImageForUpload,
  preparePhotoUpload,
  type BackgroundRemover,
} from "@/lib/images";
import { ORT_WASM_URL } from "@/lib/images/onnx-background-remover";
import { U2NETP_MODEL } from "@/lib/images/u2net";

export interface HarnessResult {
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  originalType: string;
  cutoutBytes: number | null;
  cutoutWidth: number | null;
  cutoutHeight: number | null;
  cornerAlpha: number | null;
  centreAlpha: number | null;
  cutoutFailure: string | null;
  fileName: string;
  timings: { loadMs: number; inferenceMs: number; totalMs: number } | null;
  uploadStatus: number | null;
  draftHasCutout: boolean | null;
  modelCached: boolean;
}

declare global {
  interface Window {
    gladragsCutoutHarness?: {
      run(options?: { brokenModel?: boolean; upload?: boolean; width?: number; height?: number }): Promise<HarnessResult>;
      prepareUnreadable(): Promise<string>;
    };
  }
}

/** A synthetic phone photo: a navy top on a wooden floor, as a JPEG File. */
async function syntheticPhoto(width: number, height: number): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c9a77f";
  ctx.fillRect(0, 0, width, height);
  for (let y = 0; y < height; y += 6) {
    ctx.fillStyle = `rgba(120, 85, 50, ${0.05 + 0.08 * Math.abs(Math.sin(y / 23))})`;
    ctx.fillRect(0, y, width, 3);
  }
  const s = width / 600;
  ctx.fillStyle = "#1f2c52";
  ctx.beginPath();
  const points = [
    [210, 150], [260, 130], [300, 160], [340, 130], [390, 150], [500, 235], [450, 305], [410, 275],
    [410, 650], [190, 650], [190, 275], [150, 305], [100, 235],
  ];
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x! * s, y! * s) : ctx.lineTo(x! * s, y! * s)));
  ctx.closePath();
  ctx.fill();
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.95));
  return new File([blob], "IMG_4032.HEIC.jpg", { type: "image/jpeg" });
}

async function alphaAt(blob: Blob): Promise<{ corner: number; centre: number; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const corner = ctx.getImageData(0, 0, 1, 1).data[3]!;
  const centre = ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data[3]!;
  return { corner, centre, width: bitmap.width, height: bitmap.height };
}

async function run(options: { brokenModel?: boolean; upload?: boolean; width?: number; height?: number } = {}): Promise<HarnessResult> {
  const remover: BackgroundRemover = options.brokenModel
    ? new OnnxBackgroundRemover({ model: { ...U2NETP_MODEL, url: "/models/missing.onnx" } })
    : getBackgroundRemover();
  const file = await syntheticPhoto(options.width ?? 3000, options.height ?? 4000);
  const prepared = await preparePhotoUpload(file, remover);
  const originalBitmap = await createImageBitmap(prepared.original.blob);
  const cutout = prepared.cutout ? await alphaAt(prepared.cutout) : null;

  let uploadStatus: number | null = null;
  let draftHasCutout: boolean | null = null;
  if (options.upload) {
    const res = await fetch("/api/items/photo", { method: "POST", body: buildPhotoUploadForm(prepared) });
    uploadStatus = res.status;
    if (res.ok) draftHasCutout = ((await res.json()) as { draft: { cutoutImageKey: string | null } }).draft.cutoutImageKey !== null;
  }

  return {
    originalBytes: prepared.original.blob.size,
    originalWidth: originalBitmap.width,
    originalHeight: originalBitmap.height,
    originalType: prepared.original.blob.type,
    cutoutBytes: prepared.cutout?.size ?? null,
    cutoutWidth: cutout?.width ?? null,
    cutoutHeight: cutout?.height ?? null,
    cornerAlpha: cutout?.corner ?? null,
    centreAlpha: cutout?.centre ?? null,
    cutoutFailure: prepared.cutoutFailure,
    fileName: prepared.fileName,
    timings: remover instanceof OnnxBackgroundRemover ? remover.lastTimings : null,
    uploadStatus,
    draftHasCutout,
    modelCached: await isModelCached([U2NETP_MODEL.url, ORT_WASM_URL]),
  };
}

async function prepareUnreadable(): Promise<string> {
  // HEIC bytes ("ftypheic"): Chromium can't decode them.
  const heic = new File([Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0])], "IMG_1.HEIC", {
    type: "image/heic",
  });
  try {
    await prepareImageForUpload(heic);
    return "prepared";
  } catch (error) {
    return error instanceof ImagePreparationError ? error.reason : "other";
  }
}

export function CutoutHarness() {
  const [result, setResult] = useState<HarnessResult | null>(null);
  const status = useRef<HTMLPreElement>(null);

  useEffect(() => {
    window.gladragsCutoutHarness = { run, prepareUnreadable };
    // Tests wait for this before calling the harness.
    if (status.current) status.current.textContent = "ready";
    return () => {
      delete window.gladragsCutoutHarness;
    };
  }, []);

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-semibold">Background removal test bench</h1>
      <p className="text-sm text-muted-foreground">Dev only (mock mode). Runs the real in-browser model on a synthetic photo.</p>
      <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={async () => setResult(await run({ upload: true }))}>
        Run
      </button>
      <pre ref={status} data-testid="harness-ready" className="text-xs">
        loading
      </pre>
      {result && <pre className="overflow-x-auto text-xs">{JSON.stringify(result, null, 2)}</pre>}
    </main>
  );
}
