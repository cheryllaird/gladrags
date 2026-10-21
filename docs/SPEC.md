# GladRags — v1 Spec

Source of truth for the v1 build. Exported from the reviewed spec doc on 2026-10-21. If anything here conflicts with code, the spec wins until Cheryl changes it.

## Overview

GladRags v1 is a mobile web app (PWA) that lets a user photograph or link their clothes, builds a tagged digital wardrobe, and suggests outfits from it for a chosen style or occasion. It is a prototype for Cheryl and a handful of testers, built to answer one question: do people find the suggested outfits good enough to wear?

**Problem:** people own plenty of clothes but struggle to combine them into outfits, especially for a specific occasion.

**Success criteria for the tester round**

- A tester can add 20 items in under 15 minutes.
- Auto-tagging is right for at least 4 in 5 items without edits.
- Testers rate at least half of suggested outfits "I'd wear this".
- Each tester uses it on at least 3 separate days.

## Users and core journeys

The target user owns a reasonable wardrobe but gets stuck putting it together, and uses their phone for everything. The app is for men and women alike.

1. **Build the wardrobe:** sign in, photograph an item (or paste a product link), check the auto-filled tags, save. Repeat.
2. **Get outfits for an occasion:** pick a style from the preset list or type their own, optionally add guidance ("no heels", "use my green dress"), see 3–5 outfit collages.
3. **Build around an item:** pick one item from the wardrobe and ask for outfits that include it.
4. **Refine:** reject or tweak a suggestion ("swap the shoes", "warmer"), get a revised set.
5. **Save and rate:** save outfits they like, mark ones they'd never wear, which feeds future suggestions.

## Scope

v1 covers getting items in and getting outfits out; buying and try-on wait until the core is proven.

| Feature | v1 | Later |
| --- | --- | --- |
| Add item by photo, with background removal and auto-tagging | In | |
| Add item by product link, with fallbacks | In | |
| Wardrobe browse, filter, edit, delete | In | |
| Outfit suggestions by style or occasion, using clothes and shoes | In | |
| Outfits built around a chosen item | In | |
| Free-text guidance and refinement | In | |
| Collage previews of outfits | In | |
| Save, like, reject outfits | In | |
| Bags and accessories in the wardrobe and outfits | Out | Later |
| "Complete the look" shopping suggestions | Out | v2 |
| Virtual try-on on the user's own photo | Out | v3 |
| Bring your own AI API key, for power users who want to go past the daily caps | Out | Later |
| Weather, calendar, social sharing | Out | Not planned |
| Native app store apps | Out | Not planned |

## Building the wardrobe

Every item ends up as a clean cut-out image plus structured tags, whichever way it came in.

### Add by photo

1. User takes a photo or picks one from the camera roll. The client resizes it to max 1600 px.
2. The client removes the background in the browser and uploads both the original and the cut-out. If removal fails (an older or low-memory phone, say), it uploads the original alone and the item uses the original image wherever a cut-out would appear.
3. Server strips EXIF, validates both images and stores them.
4. A vision model returns tags as strict JSON (schema below), working from the cut-out where there is one.
5. User sees the cut-out and pre-filled tags, can correct any, and saves.

One item per photo in v1. Photos of several items at once are out of scope.

### Add by link

1. User pastes a product URL (or shares it to the PWA from their browser).
2. Server fetches the page and reads structured product data (Open Graph tags, schema.org Product JSON-LD) for title, brand, image and colour.
3. Server downloads the product image and stores it as the original. The client then cuts it out in the browser and uploads the cut-out, which triggers tagging.
4. **Fallback** when the site blocks fetching or has no usable data: ask the user to upload a screenshot of the product, which then goes down the photo route.

The source URL is kept on the item.

### Tags per item

- **Category** and **subcategory**: top (t-shirt, shirt, blouse, polo, jumper); bottom (jeans, trousers, chinos, skirt, shorts); dress or jumpsuit; outerwear (jacket, blazer, coat); shoes. The categories cover menswear and womenswear alike, with no gender setting: users simply add what they own.
- **Colours** (primary and secondary) and **pattern** (plain, stripe, floral, check, print)
- **Formality** on a 1–5 scale, from loungewear to formal
- **Seasons** and **warmth**
- **Occasions** it suits (any of the preset styles)
- **Fabric** (where visible) and a one-line **description**

### Wardrobe screen

A grid of cut-outs, filterable by category, colour and occasion, with search on the description. Tapping an item opens it to edit tags, delete it, or "build an outfit around this".

## Outfit suggestions

Code guarantees every outfit is wearable; the AI model only chooses and explains, so it can never return an outfit that isn't actually possible from the wardrobe.

### Request

Style or occasion (one of the presets below, or free text), optional anchor item, optional free-text guidance, number of outfits (default 4).

Each preset sets a formality band, which the filter step uses before ranking.

| Style | Formality (1–5) | Covers |
| --- | --- | --- |
| Comfy | 1 | At home, lounging, low-key errands |
| Active | 1–2 | Gym, walks, outdoor days |
| Casual | 1–2 | Everyday, weekends, coffee with friends |
| Holiday | 1–3 | Beach, city breaks, warm-weather days out |
| Smart casual | 2–3 | Lunch out, meeting friends, relaxed offices |
| Work | 3–4 | Office, meetings, interviews |
| Evening out | 3–4 | Dinner, drinks, date night, theatre |
| Wedding guest | 4 | Daytime and evening weddings, christenings |
| Formal event | 4–5 | Races, black tie, galas, awards |

### Pipeline

1. **Filter:** drop items whose formality, season or occasion tags clearly don't fit the request.
2. **Generate candidates in code:** valid combinations only. Either top + bottom, or a dress or jumpsuit, plus shoes, with optional outerwear. Must include the anchor item if given.
3. **Rank with the AI model, in two passes.** First, send the filtered wardrobe's tags plus the request and guidance; the model shortlists about 8 outfits by item ID. Then send small thumbnails (around 256 px) of each shortlisted outfit's cut-outs, so the model can judge real shades, textures and proportions. It picks the best N, each with a short name and a one-line reason ("Navy and tan keep this smart without being stiff").
4. **Validate:** reject any outfit with an unknown item ID or a broken composition rule, then retry once.
5. **Render** a collage for each outfit.

If the wardrobe can't make a valid outfit (no shoes yet, say), the app tells the user which category is missing.

### Refinement

On any outfit the user can tap "swap" on one item, or type guidance ("warmer", "less formal"). The previous outfit and the feedback go back to the model, which returns a revised set.

### Collage preview

The cut-outs are arranged in a fixed flat-lay layout: top or dress upper centre, bottom below, shoes at the foot, outerwear to the side. The collage is rendered on the client with canvas, and the user can save it as an image. No generated images in v1.

### Saving and feedback

Users can save, like or reject each outfit. Rejected item pairings are sent to the model as "avoid" hints on later requests.

## Data model

Four tables in Postgres. Images live in object storage and are referenced by key.

| Table | Key fields |
| --- | --- |
| users | id, email, display_name, created_at |
| items | id, user_id, source (photo, link), source_url, original_image_key, cutout_image_key (null if background removal failed), category, subcategory, colours[], pattern, formality (1–5), seasons[], warmth, occasions[], fabric, description, tags_edited (bool), created_at |
| outfits | id, user_id, request (style, guidance, anchor_item_id), name, reason, item_ids[], status (suggested, saved, liked, rejected), parent_outfit_id (for refinements), created_at |
| outfit_feedback | id, outfit_id, user_id, kind (swap, guidance, reject), detail, created_at |

The tagging model must return JSON that validates against the items schema (a shared Zod schema). Anything that fails validation is retried once, then shown to the user with empty tags to fill in.

## Architecture and stack

One Next.js app on Vercel, with Supabase for auth, database and image storage, and one external AI service (Gemini). Background removal runs on the user's phone. That keeps the moving parts few enough for a prototype.

| Layer | Choice | Why |
| --- | --- | --- |
| App | Next.js (App Router) + TypeScript, deployed as a PWA on Vercel | One codebase; camera upload and "add to home screen" work on phones |
| UI | Tailwind CSS + shadcn/ui | Fast to build, easy for agents to keep consistent |
| Auth, DB, storage | Supabase (email magic link, Postgres, Storage) | One service for three needs; row-level security keeps each tester's wardrobe private |
| Background removal | In the browser, using an open-source segmentation model run on the phone (WebAssembly/WebGPU), behind an interface so it can be swapped | Free, no extra API key, and photos aren't sent to another third party; the model downloads once and is cached |
| Tagging and outfit ranking | Gemini API (a Flash model): vision for tagging, ranking in two passes, structured JSON output. Behind a provider interface so it can be swapped | Free tier for development; ranking shortlists on tags and only sends thumbnails for the shortlist, so it stays cheap |
| Link import | Server-side fetch + Open Graph / JSON-LD parsing | No scraping service needed for v1 |
| Testing | Vitest for logic, Playwright for the core journeys on a mobile viewport | Gives review agents something to run |

**Cost controls:** each tester gets a daily cap on new items and outfit requests. Tags are generated once per item and stored. Outfit requests send images only for the shortlist, as small thumbnails, which keeps image costs bounded. Real per-request costs get measured in the first tester week. Total AI spend (Gemini) is capped at £5 a month during testing. Budget alerts fire at 50% and 90%, but they don't stop charges, so the app tracks its own spend and pauses AI features when the cap is reached. Bring-your-own API key is a later option (see Scope).

## Privacy and security

Even with only a few testers, photos can be taken in someone's bedroom, so treat every image as private.

- Sign-up is invite-only through an allowlist of tester emails.
- Row-level security on every table, so a user can only read their own items and outfits.
- Storage buckets are private and images are served through short-lived signed URLs.
- Strip EXIF data (including location) from uploads before storing them.
- Users can delete an item and its images, or delete their whole account and data.
- Secrets live only in environment variables (`.env.local` locally, Vercel in deployment), never in the repo.
- A one-page privacy note for testers listing the third-party services that see their images (Google Gemini; background removal runs on their phone, so it sees nothing). Switch Gemini to the paid tier before testers join: on the free tier, Google can use prompts and images to improve its products.
- Body photos for try-on are out of v1 entirely, which avoids the most sensitive data until it's needed.

## Agent swarm build plan

One foundations agent sets up the shared contracts first. Then five builder agents work in parallel on separate branches, and agents that didn't write the code review and test it before anything merges. Agent definitions live in `.claude/agents/`; the main Claude Code session is the orchestrator (see `CLAUDE.md`).

| Agent | Owns | Depends on |
| --- | --- | --- |
| Orchestrator (main session) | Task breakdown, assigning work, merging, reporting to Cheryl | This spec |
| foundations | Repo scaffold, Supabase schema and RLS, shared Zod types, auth, API route contracts, CI, Vercel project | Spec approval |
| ingestion | Photo upload, resizing, EXIF stripping, background removal, tagging | foundations |
| link-import | URL fetch, product data parsing, screenshot fallback | foundations, ingestion's tagging step |
| wardrobe-ui | Add-item flow, tag review form, wardrobe grid, filters, item detail | foundations contracts (mocked APIs until ready) |
| outfit-engine | Filtering, candidate generation, two-pass model ranking, validation, refinement, feedback hints | foundations |
| outfit-ui | Request screen, style chips, results, collage renderer, swap and refine, saved outfits | foundations contracts (mocked APIs) |
| reviewer | Code review on every branch against this spec | Each builder's branch |
| qa | Unit and Playwright tests for the five core journeys on a mobile viewport | Each builder's branch |
| security | RLS, signed URLs, secrets and upload handling checks | Before the tester build |

### Milestones and Cheryl's checkpoints

1. **Spec sign-off.** Done.
2. **Foundations.** Schema, types and API contracts are merged. Cheryl checks the contracts match the spec.
3. **Parallel build.** The builders work on separate branches against the contracts. Each branch passes review and tests before it merges. Cheryl sees a preview build of the screens part-way through.
4. **Integration.** The orchestrator merges everything and runs the full journey tests. A preview deploy goes to Vercel.
5. **Cheryl's test.** She uses it on her phone with her own wardrobe. Fixes come from her notes.
6. **Tester build.** Invite the testers and measure against the success criteria.

A branch merges only when it is reviewed, tests pass, and it has no changes to a shared contract it doesn't own. A contract change goes back to the orchestrator.

## Decisions

- Name: **GladRags**.
- Success criteria above stand for now; revisit after the first tester week.
- The nine preset styles are approved.
- v1 outfits use clothes and shoes only; bags and accessories come later.
- For men and women: categories and the collage layout cover menswear and womenswear.
- Supabase for auth, database and storage; Gemini API for tagging and ranking. Cheryl owns both accounts and keys.
- Background removal runs in the browser, not through a hosted service (decided 2026-10-21, replacing Replicate). The model and runtime must have a licence that allows use in this app; check with Cheryl before using anything copyleft (e.g. AGPL) or non-commercial.
- Code lives in this private repo, `cheryllaird/gladrags`.
- AI costs capped at £5 a month during testing.

## Still open

- Look and feel: reference apps, colours, mood. Until decided, use a clean, neutral design with shadcn/ui defaults so it's easy to restyle later.
