# Model preset images

One picture per model preset in `MODEL_PRESETS` (`src/contracts/previews.ts`), named `<preset id>.webp`.

**These are placeholders**: neutral silhouettes made by `scripts/make-preview-placeholders.mjs`, labelled "PLACEHOLDER". The orchestrator replaces them with the real generated set once the Gemini paid tier is on (PROGRESS.md task P5), checks them with Cheryl, and then sets `MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS` to `false`.

Real presets: full length, front facing, plain light background, neutral fitted base clothing, 2:3 portrait, WebP, about 1024 × 1536.
