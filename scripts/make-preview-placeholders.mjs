// Makes the PLACEHOLDER images for generated outfit previews (round 2):
//
// - public/presets/<preset id>.webp: one neutral silhouette per model
//   preset (24), labelled "PLACEHOLDER". The orchestrator replaces them with
//   the real generated set (PROGRESS.md task P5), then sets
//   MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS to false in src/contracts/previews.ts.
// - src/lib/ai/fixtures/*.png: recorded "model replies" for tests (a good
//   2:3 portrait and a square one that fails the aspect check).
//
// Run: node scripts/make-preview-placeholders.mjs (needs sharp, a dependency).
// The preset list must match MODEL_PRESETS in src/contracts/previews.ts;
// src/contracts/previews.test.ts checks every preset has its file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BUILDS = { women: ["slim", "average", "curvy", "plus"], men: ["slim", "average", "broad", "plus"] };
const TONES = { light: "#e8c9a8", medium: "#b98a5e", deep: "#6b4429" };
// Half-widths of shoulders, waist and hips for each build, in a 512 x 768 frame.
const SHAPES = {
  women: { slim: [52, 34, 50], average: [58, 42, 60], curvy: [62, 42, 78], plus: [76, 66, 86] },
  men: { slim: [62, 44, 48], average: [70, 52, 56], broad: [88, 58, 60], plus: [84, 76, 78] },
};

function silhouette(gender, build, tone) {
  const [shoulder, waist, hip] = SHAPES[gender][build];
  const cx = 256;
  const body = [
    `M ${cx - shoulder} 210`,
    `L ${cx - waist} 380`,
    `L ${cx - hip} 470`,
    `L ${cx - 34} 720`,
    `L ${cx - 8} 720`,
    `L ${cx} 500`,
    `L ${cx + 8} 720`,
    `L ${cx + 34} 720`,
    `L ${cx + hip} 470`,
    `L ${cx + waist} 380`,
    `L ${cx + shoulder} 210`,
    "Z",
  ].join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768" viewBox="0 0 512 768">
  <rect width="512" height="768" fill="#f2f2f0"/>
  <circle cx="${cx}" cy="140" r="52" fill="${TONES[tone]}"/>
  <rect x="${cx - 16}" y="186" width="32" height="30" fill="${TONES[tone]}"/>
  <path d="${body}" fill="${TONES[tone]}"/>
  <text x="256" y="60" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#9a9a96">PLACEHOLDER</text>
  <text x="256" y="755" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#9a9a96">${gender} · ${build} · ${tone}</text>
</svg>`;
}

const presetsDir = join(root, "public", "presets");
mkdirSync(presetsDir, { recursive: true });
let count = 0;
for (const [gender, builds] of Object.entries(BUILDS)) {
  for (const build of builds) {
    for (const tone of Object.keys(TONES)) {
      const webp = await sharp(Buffer.from(silhouette(gender, build, tone))).webp({ quality: 70 }).toBuffer();
      writeFileSync(join(presetsDir, `${gender}_${build}_${tone}.webp`), webp);
      count++;
    }
  }
}

const fixturesDir = join(root, "src", "lib", "ai", "fixtures");
mkdirSync(fixturesDir, { recursive: true });
const plain = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 236, g: 232, b: 226 } } }).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(fixturesDir, "preview-832x1248.png"), await plain(832, 1248));
writeFileSync(join(fixturesDir, "preview-1024x1024.png"), await plain(1024, 1024));

console.log(`Wrote ${count} preset placeholders and 2 test fixtures.`);
