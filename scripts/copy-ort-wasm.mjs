// Copies ONNX Runtime Web's WebAssembly file into public/ort so the browser
// background remover can download it from this site (and cache it). Runs
// before `next dev` and `next build`. The copy is gitignored.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules", "onnxruntime-web", "dist");
const target = join(root, "public", "ort");
const file = "ort-wasm-simd-threaded.wasm";

mkdirSync(target, { recursive: true });
copyFileSync(join(dist, file), join(target, file));
const { version } = JSON.parse(readFileSync(join(root, "node_modules", "onnxruntime-web", "package.json"), "utf8"));
console.log(`Copied onnxruntime-web ${version} ${file} to public/ort`);
