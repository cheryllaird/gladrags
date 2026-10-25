/**
 * The background-removal model: the shipped file is the expected one, the
 * pre/post-processing maths is right, and the real model (run with ONNX
 * Runtime Web's WebAssembly backend, as in the browser) cuts a garment out
 * of a synthetic flat-lay photo. Local files only, no network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ORT_VERSION, ORT_WASM_URL } from "./onnx-background-remover";
import {
  MAX_SUBJECT_COVERAGE,
  MIN_SUBJECT_COVERAGE,
  U2NETP_MODEL,
  cropBox,
  fitWithin,
  hasUsableSubject,
  maskFromPrediction,
  maskStats,
  toModelInput,
} from "./u2net";

const ROOT = join(__dirname, "..", "..", "..");
const MODEL_PATH = join(ROOT, "public", "models", "u2netp.onnx");

describe("shipped model and runtime", () => {
  it("public/models/u2netp.onnx is the checked U²-Netp file", () => {
    const bytes = readFileSync(MODEL_PATH);
    expect(bytes.byteLength).toBe(U2NETP_MODEL.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(U2NETP_MODEL.sha256);
    expect(U2NETP_MODEL.url).toMatch(/^\/models\/u2netp\.onnx\?v=/);
  });

  it("ships its licence notice", () => {
    expect(readFileSync(join(ROOT, "public", "models", "u2netp.LICENSE.txt"), "utf8")).toMatch(/Apache License/);
    expect(readFileSync(join(ROOT, "public", "models", "NOTICE.txt"), "utf8")).toContain(U2NETP_MODEL.sha256);
  });

  it("the runtime URL's version matches the installed onnxruntime-web", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "onnxruntime-web", "package.json"), "utf8")) as { version: string };
    expect(ORT_VERSION).toBe(pkg.version);
    expect(ORT_WASM_URL).toContain(pkg.version);
  });
});

describe("toModelInput", () => {
  it("makes planar RGB, scaled by the brightest value and ImageNet-normalised, ignoring alpha", () => {
    // 1×1... as 2×2: red, green, blue, grey(128). Alpha 0 must not matter.
    const rgba = Uint8ClampedArray.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 9, 128, 128, 128, 255]);
    const out = toModelInput(rgba, 2);
    expect(out).toHaveLength(12);
    const [mr, mg, mb] = U2NETP_MODEL.mean;
    const [sr, sg, sb] = U2NETP_MODEL.std;
    expect(out[0]).toBeCloseTo((1 - mr) / sr); // R plane, pixel 0
    expect(out[4 + 1]).toBeCloseTo((1 - mg) / sg); // G plane, pixel 1
    expect(out[8 + 2]).toBeCloseTo((1 - mb) / sb); // B plane, pixel 2
    expect(out[3]).toBeCloseTo((128 / 255 - mr) / sr); // R plane, grey pixel
  });

  it("refuses data of the wrong size", () => {
    expect(() => toModelInput(new Uint8ClampedArray(10), 2)).toThrow(/Expected 16/);
  });
});

describe("maskFromPrediction", () => {
  it("stretches to 0–1, cuts faint haze to transparent and makes the item opaque", () => {
    const mask = maskFromPrediction(Float32Array.from([0.2, 0.25, 0.6, 1.0, 0.95]));
    // normalised: 0, 0.0625, 0.5, 1, 0.9375
    expect(Array.from(mask)).toEqual([0, 0, 128, 255, 255]);
  });

  it("gives an empty mask for a flat prediction", () => {
    expect(Array.from(maskFromPrediction(Float32Array.from([0.4, 0.4, 0.4])))).toEqual([0, 0, 0]);
  });
});

describe("maskStats, hasUsableSubject and cropBox", () => {
  const size = 10;
  const square = () => {
    const mask = new Uint8ClampedArray(size * size);
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) mask[y * size + x] = 255;
    return mask;
  };

  it("measures coverage and the bounding box", () => {
    expect(maskStats(square(), size)).toEqual({ coverage: 0.2, box: { x: 3, y: 2, width: 5, height: 4 } });
    expect(maskStats(new Uint8ClampedArray(size * size), size)).toEqual({ coverage: 0, box: null });
  });

  it("rejects nothing found and everything found", () => {
    expect(hasUsableSubject(maskStats(square(), size))).toBe(true);
    expect(hasUsableSubject({ coverage: MIN_SUBJECT_COVERAGE / 2, box: { x: 0, y: 0, width: 1, height: 1 } })).toBe(false);
    expect(hasUsableSubject({ coverage: (MAX_SUBJECT_COVERAGE + 1) / 2, box: { x: 0, y: 0, width: 10, height: 10 } })).toBe(false);
    expect(hasUsableSubject({ coverage: 0.3, box: null })).toBe(false);
  });

  it("scales the box to the photo, adds a margin and stays inside", () => {
    expect(cropBox({ x: 3, y: 2, width: 5, height: 4 }, 10, 1000, 500, 0)).toEqual({ x: 300, y: 100, width: 500, height: 200 });
    expect(cropBox({ x: 0, y: 0, width: 10, height: 10 }, 10, 1000, 500)).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    expect(cropBox({ x: 3, y: 2, width: 5, height: 4 }, 10, 1000, 500)).toEqual({ x: 270, y: 70, width: 560, height: 260 });
  });

  it("fitWithin keeps the aspect ratio and never enlarges", () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("the real model on a synthetic flat-lay photo (WebAssembly, as in the browser)", () => {
  it("finds the garment and not the floor", { timeout: 30_000 }, async () => {
    const size = U2NETP_MODEL.inputSize;
    // A navy top on a wood-coloured floor, occupying a known region.
    const W = 600;
    const H = 800;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#c9a77f"/>
      <path d="M210 150 L260 130 Q300 165 340 130 L390 150 L500 235 L450 305 L410 275 L410 650 L190 650 L190 275 L150 305 L100 235 Z" fill="#1f2c52"/>
    </svg>`;
    const photo = sharp(Buffer.from(svg));
    const rgba = await photo.clone().resize(size, size, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    // Ground truth at model resolution: the garment's pixels are the dark ones.
    const truth = await photo.clone().resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();

    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = readFileSync(join(ROOT, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"));
    const session = await ort.InferenceSession.create(readFileSync(MODEL_PATH), { executionProviders: ["wasm"] });
    const input = new ort.Tensor("float32", toModelInput(new Uint8ClampedArray(rgba), size), [1, 3, size, size]);
    const output = await session.run({ [session.inputNames[0]!]: input });
    const mask = maskFromPrediction(output[session.outputNames[0]!]!.data as Float32Array);

    const stats = maskStats(mask, size);
    expect(hasUsableSubject(stats)).toBe(true);
    let both = 0;
    let either = 0;
    for (let i = 0; i < mask.length; i++) {
      const isGarment = truth[i]! < 100;
      const isMasked = mask[i]! >= 128;
      if (isGarment && isMasked) both++;
      if (isGarment || isMasked) either++;
    }
    // Intersection over union of the cut-out and the real garment.
    expect(both / either).toBeGreaterThan(0.9);
  });
});
