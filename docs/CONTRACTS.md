# GladRags contracts

What the foundations branch fixes in place for every other agent: the data model, the shared types, and what each API route accepts and returns. Cheryl approves this at checkpoint 2, before the parallel build starts.

The code is the precise version: Zod schemas in `src/contracts/`, SQL in `supabase/migrations/`. This document says the same thing in plain language. If they ever disagree, the code is wrong or this document is stale, so fix one of them.

**Decisions for Cheryl** are marked **[Decision]**. They're collected at the end too.

---

## 1. How the pieces fit

- One Next.js app. Pages and API routes live in `src/app/`.
- Supabase holds auth, the Postgres database and the image storage.
- Gemini does tagging and outfit ranking, behind interfaces in `src/lib/ai/`.
- **Background removal runs in the user's browser**, behind an interface in `src/lib/images/`. There's no hosted service and no cost.
- Every request body, query string, model reply and scraped page is checked against a Zod schema from `src/contracts/` before use.

### Mock mode

Set `GLADRAGS_MOCK_MODE=true` and the app runs with no accounts at all:

- Sign-in is skipped. Everyone is a fixed mock user, and in this mode any code of 6 to 10 digits "works".
- The API routes serve an in-memory wardrobe of 12 items covering every category, menswear and womenswear. One of them (the camel coat) has no cut-out, so the UI's fallback path gets exercised.
- Adding, editing, deleting, outfit requests, swaps and saves all work, and reset when the server restarts.

The UI agents build against mock mode until the backend branches merge. Outside mock mode the stub routes refuse with `not_implemented`, so a deployed build can never hand out the shared mock data.

Because mock mode turns sign-in off, the app refuses to start in it on Vercel, or in a production build (`pnpm start`), and reports a configuration error. The one exception is end-to-end tests, which set `GLADRAGS_E2E=true` to run mock mode against `pnpm start`.

Try it: `GLADRAGS_MOCK_MODE=true pnpm dev`, then open <http://localhost:3000> or <http://localhost:3000/api/items>.

**Markers for the error and fallback states.** Put one of these texts where the mock routes look, and they answer as if it really happened:

| Marker | Result |
| --- | --- |
| `mock-no-tags` | The draft comes back with `suggestedTags: null`: tagging failed twice, so the user fills the tags in |
| `mock-ai-paused` | `503 ai_paused`: the monthly AI spend cap is reached |
| `mock-daily-cap` | `429 daily_cap_reached`: today's cap for that action is used up |

Where to put them:
- Add by photo: in the original file's name, e.g. `shirt-mock-no-tags.jpg`.
- Add by link: anywhere in the URL, e.g. `https://shop.example.com/p?x=mock-ai-paused`.
- Outfits and refinements: in the guidance or the custom style text.

On top of that, a link whose host contains `blocked`, `nodata` or `noimage` gives the screenshot fallback, with that reason.

---

## 2. Data model

Seven tables in Postgres: the spec's four (`users`, `items`, `outfits`, `outfit_feedback`), plus three the server needs: `usage_events`, `allowed_emails` and `link_imports`. Row-level security (RLS) is on for every table. Signed-out visitors get nothing. A signed-in user can only see and change their own rows in the spec's four tables, and can read their own `usage_events`. The other two tables are server-only.

### users
| Field | Notes |
| --- | --- |
| id | Same as the Supabase auth user ID |
| email | Lower-cased |
| display_name | Defaults to the part of the email before the @. Users can change only this field. |
| created_at | |

A row is created automatically when someone signs in for the first time. Deleting the auth user deletes everything they own.

### items
| Field | Notes |
| --- | --- |
| id, user_id, created_at | |
| source | `photo` or `link` |
| source_url | Required when source is `link` (screenshot fallback included) |
| original_image_key | The resized photo or product image. Always present. |
| cutout_image_key | The transparent cut-out. **Can be empty** when removal failed on the phone; the app then shows the original. |
| category, subcategory, colours[], pattern, formality, seasons[], warmth, occasions[], fabric, description | The tags; see section 3 |
| tags_edited | True if the user changed any auto-filled tag. This measures "tagging right for 4 in 5 items". |

The database also enforces that the subcategory belongs to the category, that the values come from the fixed lists, and that both images sit in the owner's own storage folder.

### outfits
| Field | Notes |
| --- | --- |
| id, user_id, created_at | |
| request | What was asked for: `{ style, guidance, anchorItemId }` |
| name, reason | From the model, e.g. "Easy office" / "Navy and tan keep this smart without being stiff" |
| item_ids[] | 2 to 4 items |
| status | `suggested`, `saved`, `liked` or `rejected` |
| parent_outfit_id | Set when this outfit came from refining another one |

A trigger refuses outfits that use someone else's items. **[Decision]** Deleting an item also deletes every outfit that used it, saved ones included, because those outfits can no longer be shown.

### outfit_feedback
| Field | Notes |
| --- | --- |
| id, outfit_id, user_id, created_at | |
| kind | `swap`, `guidance` or `reject` |
| detail | swap: the ID of the item swapped out. guidance: the text. reject: the user's reason, or empty. |

Feedback is append-only: users can't edit or delete it. Rejections become "avoid" hints on later requests.

### usage_events (addition to the spec)
**[Decision]** One row per capped action or Gemini call: `kind`, `cost_pence` and `provider`. It backs the daily caps and the £5/month cap (section 7). Only the server can write here, so users can't reset their own counters. When an account is deleted its rows are kept but unlinked, so the month's spend still counts.

### allowed_emails (the tester allowlist)
**[Decision]** The allowlist is a table, not an environment variable. A trigger on Supabase's auth table refuses to create an account for any other email, or to change an account's email to one that isn't listed. That holds even if someone calls Supabase's auth API directly with the public key, which an env-var check in our code couldn't stop. Only the server can read it.

Add a tester in the Supabase SQL editor:

```sql
insert into public.allowed_emails (email, note) values ('someone@example.com', 'tester');
```

### link_imports (add-by-link in progress)
One row per add-by-link step 1: the source URL, the product data the server read, the stored image's key, and `tagged_at`. Step 2 claims the row in one statement, and only if it's unused, under an hour old, and the user's own. So each link can be tagged once, and step 2 uses what the server read rather than anything the phone sends back. Server-only.

### Image storage
Two private buckets, `originals` and `cutouts`. Object names are `<user id>/<random id>.<ext>`. Only the server writes images, after checking them and stripping EXIF. A signed-in user can read and delete objects in their own folder, but can't upload or change them directly. Images are served through signed URLs that expire: one hour for wardrobe and outfit images, and 10 minutes for the product image in add-by-link.

---

## 3. Item tags

| Tag | Values |
| --- | --- |
| category | `top`, `bottom`, `dress_jumpsuit`, `outerwear`, `shoes` |
| subcategory, top | `t_shirt`, `shirt`, `blouse`, `polo`, `jumper` |
| subcategory, bottom | `jeans`, `trousers`, `chinos`, `skirt`, `shorts` |
| subcategory, dress_jumpsuit | `dress`, `jumpsuit` **[Decision]** |
| subcategory, outerwear | `jacket`, `blazer`, `coat` |
| subcategory, shoes | `trainers`, `boots`, `sandals`, `heels`, `flats`, `loafers`, `smart_shoes` (brogues, oxfords, derbies) **[Decision]** |
| colours | 1 to 3, the first is the main colour, from a fixed palette: black, white, cream, beige, tan, brown, grey, navy, blue, light_blue, teal, green, olive, yellow, orange, red, burgundy, pink, purple, gold, silver **[Decision]** |
| pattern | `plain`, `stripe`, `floral`, `check`, `print` |
| formality | Whole number, 1 (loungewear) to 5 (formal) |
| seasons | 1 to 4 of `spring`, `summer`, `autumn`, `winter`. All four means all year. **[Decision]** |
| warmth | `light` (linen shirt, sandals), `medium` (jeans, cotton jumper), `warm` (wool coat, chunky knit) **[Decision]** |
| occasions | At least one of the nine preset style IDs (section 4) |
| fabric | Short text such as "denim", or empty if it can't be seen. A blank or missing value from the model counts as empty. |
| description | One line of at most 120 characters, such as "Navy slim-fit chinos". Wardrobe search uses it. |

The spec lists subcategories as "t-shirt" and so on. In code they're lower-case IDs with underscores (`t_shirt`), and the UI shows friendly labels.

Every text field that can reach a model prompt (tags, guidance, custom styles, scraped product data) is a single line with a length limit. That stops anyone adding new lines that look like separate prompt sections. It does **not** stop prompt injection on its own: "Ignore previous instructions" fits on one line. The prompts themselves must treat user and scraped text as data, and the outputs are checked against these schemas, which limits what a successful injection could do.

---

## 4. Styles and outfits

### The nine preset styles
| ID | Label | Formality |
| --- | --- | --- |
| comfy | Comfy | 1 |
| active | Active | 1–2 |
| casual | Casual | 1–2 |
| holiday | Holiday | 1–3 |
| smart_casual | Smart casual | 2–3 |
| work | Work | 3–4 |
| evening_out | Evening out | 3–4 |
| wedding_guest | Wedding guest | 4 |
| formal_event | Formal event | 4–5 |

A request picks a preset or types its own words (up to 100 characters). A typed style has no fixed formality band; the outfit engine works one out.

### What counts as a wearable outfit
Either **one top and one bottom**, or **one dress or jumpsuit**. Plus **exactly one pair of shoes**, plus **at most one piece of outerwear**. That makes 2 to 4 items.

**[Decision]** v1 has no layering, so it's one top only (no shirt under a jumper). This is easy to relax later.

The rule is one shared function, `checkComposition`. The outfit engine uses it both when generating candidates and when checking the model's picks.

### Outfit request
- `style`: a preset or custom text (required)
- `anchorItemId`: build every outfit around this item (optional)
- `guidance`: e.g. "no heels" (optional, one line, up to 200 characters)
- `count`: 3 to 5, default 4

### When outfits can't be made
This isn't an error. The response says `incomplete_wardrobe`, with one of two reasons:
- `missing_category`: no valid combination exists at all. It also lists what to add, e.g. `["shoes"]`, or `["top", "bottom"]` if there are no separates and no dresses. With an anchor item, the list is about outfits that include the anchor. For example, building around a top with no bottoms in the wardrobe gives `["bottom"]`, even if there's a dress, because the dress can't be worn with the top. The shared function `missingCategoriesForOutfits(present, anchorCategory)` works this out.
- `nothing_fits`: combinations exist, but none suit this style or anchor.

---

## 5. API routes

All routes are under `/api` and return JSON. Every route except the sign-in ones needs a signed-in user. Errors always look like this:

```json
{ "error": { "code": "daily_cap_reached", "message": "Plain English for the user", "cap": { "kind": "items_per_day", "limit": 40, "resetsAt": "…" } } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| bad_request | 400 | Input failed validation. `issues` lists the fields. |
| unauthorized | 401 | Not signed in, or the sign-in code was wrong |
| not_invited | 403 | Email isn't on the allowlist |
| not_found | 404 | Doesn't exist, or isn't yours (deliberately the same answer) |
| daily_cap_reached | 429 | Per-user daily cap hit; `cap` says which and when it resets |
| ai_paused | 503 | Monthly AI spend cap hit; adding and new outfits pause until next month |
| ai_failed | 502 | The model failed twice |
| server_misconfigured | 500 | Missing environment variables |
| not_implemented | 501 | Stub route called outside mock mode |
| internal | 500 | Anything else |

"Built" below means it's a real implementation now. "Stub" means it validates input and serves mock data until the named agent replaces it.

### Sign-in (built)
| Route | Send | Get back |
| --- | --- | --- |
| `POST /api/auth/magic-link` | `{ email, next? }` | `{ sent: true }`, or `not_invited` |
| `POST /api/auth/verify-code` | `{ email, code, next? }`. The code is whatever Supabase emails: 6 digits by default, and the route accepts 6 to 10 because Supabase lets the length be changed. | `{ signedIn: true, next }` |
| `POST /api/auth/sign-out` | nothing | `{ signedOut: true }`. A plain HTML form post is redirected to /sign-in instead. |
| `GET /auth/callback?code=…` | (link from the default email) | Signs in, then redirects to `next` |
| `GET /auth/confirm?token_hash=…&type=email` | (link from a customised email) | Signs in, then redirects to `next` |

`next` must be a path on this site, which prevents open redirects.

**Why a code as well as a link:** on iPhone, an app added to the home screen doesn't share cookies with Safari. Tapping the emailed link signs you into Safari, not the app. Typing the code into the app works everywhere. For this, the Supabase email template needs `{{ .Token }}` added (see section 9). A minimal working sign-in page is at `/sign-in`, which wardrobe-ui will restyle.

### Wardrobe items (stubs; owner: ingestion, and link-import for the link routes)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/items?category=&colour=&occasion=&q=` | All filters optional; `q` searches descriptions | `{ items: WardrobeItem[] }` |
| `POST /api/items` | `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), tags, tagsEdited }` | `201 { item }` |
| `GET /api/items/:id` | | `{ item }` |
| `PATCH /api/items/:id` | `{ tags }` (all of them) | `{ item }` with `tagsEdited: true` |
| `DELETE /api/items/:id` | | `{ deleted: true }`. Also deletes its images and the outfits that used it. |

A **WardrobeItem** is `{ id, source, sourceUrl, originalUrl, cutoutUrl (or null), tags, tagsEdited, createdAt }`. Show `cutoutUrl` if there is one, otherwise `originalUrl`; the helper `displayImageUrl(item)` does this.

### Add by photo (stub; owner: ingestion)
On the phone:
1. Resize the photo to at most 1600 px on its longest side, and re-encode it as JPEG. iPhones take HEIC photos by default, and the server rejects HEIC.
2. Try to cut the item out in the browser.
3. Upload. If the cut-out failed (old or low-memory phones), upload without one.

`POST /api/items/photo`, sent as a multipart form, not JSON:

| Field | Required | Rules |
| --- | --- | --- |
| `original` | yes | JPEG, PNG or WebP; ≤ 1600 px; ≤ 1.5 MB |
| `cutout` | no | PNG with transparency; ≤ 1600 px; ≤ 2.5 MB |
| `sourceUrl` | no | Set for the screenshot fallback from add-by-link, so the item keeps its link |

On the server:
1. Check the daily item cap, and count this item: tagging happens in this request.
2. Check each file's real type from its bytes, not the name the phone gives it. HEIC, GIF and anything else are refused. Check size and pixel dimensions too.
3. Check the cut-out really has an alpha (transparency) channel. A PNG without one isn't a cut-out, so it's treated as missing. (The stub can't check this yet; the ingestion agent adds it with the image decoder.)
4. Strip EXIF data, including location, from both images.
5. Store both in the private buckets.
6. Tag the cut-out if there is one, otherwise the original.
7. Return `{ draft }`.

A **draft** is `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), originalUrl, cutoutUrl (or null), suggestedTags (or null) }`. If tagging fails twice, `suggestedTags` is null and the user fills the tags in. The user reviews the draft and saves it with `POST /api/items`.

**Why these sizes:** Vercel limits a request to 4.5 MB, and both files travel together. A 1600 px JPEG is usually under 1 MB. If a cut-out PNG comes out over 2.5 MB, the phone shrinks it until it fits. **[Decision]**

### Add by link, two steps (stubs; owner: link-import)
**Step 1:** `POST /api/items/link` with `{ url }`.

The server first checks the daily item cap, so a user at their limit isn't sent through step 2 for nothing. It doesn't count the item yet; no AI runs in this step. It then fetches the page, reads the product data, downloads the product image, resizes it, strips EXIF and stores it as the original. It records the import (source URL and product data) in `link_imports`, and returns either:
- `{ status: "ok", sourceUrl, originalImageKey, originalUrl, product: { title, brand, colour } }`. Here `originalUrl` is a signed URL that lasts 10 minutes. `product` is for display only.
- `{ status: "needs_screenshot", reason, sourceUrl, message }`. The reason is `fetch_blocked`, `no_product_data` or `no_image`. The phone asks for a screenshot and sends it through add-by-photo with `sourceUrl`, so the item keeps its link.

Scraped product text is cleaned before it's used: line breaks are flattened to spaces, it's trimmed and length-limited (title 200, brand 80, colour 60 characters), and blanks become empty.

**Step 2:** the phone loads `originalUrl`, cuts the item out, and calls `POST /api/items/link/cutout`, as a multipart form:

| Field | Required | Rules |
| --- | --- | --- |
| `meta` | yes | JSON text: `{ originalImageKey }` from step 1. Anything else in it is ignored. |
| `cutout` | no | PNG, as for add-by-photo. Leave it out if removal failed. |

The server:
1. Checks the daily item cap.
2. Claims the import: it must be the user's, unused, and less than an hour old. Otherwise the answer is `404 not_found`, meaning "paste the link again". **Each import can be tagged only once**, so replaying step 2 can't run Gemini again.
3. Counts the item against the daily cap.
4. Checks and stores the cut-out.
5. Tags the cut-out (or the original), using the product title, brand and colour **it stored in step 1** as hints. It never uses data the phone sends back.
6. Returns `{ draft }`, exactly as add-by-photo does.

An import that's never finished leaves an unused image in storage. The link-import agent should clear out old unused imports and their images.

Android can "share" a product page straight to the installed app; it opens `/add/link?url=…` (a wardrobe-ui page). iPhone doesn't support this, so users paste the link.

### Outfits (stubs; owner: outfit-engine)
| Route | Send | Get back |
| --- | --- | --- |
| `POST /api/outfits` | The outfit request (section 4) | `{ status: "ok", outfits }` or `{ status: "incomplete_wardrobe", reason, missingCategories, message }`. `missingCategories` takes the anchor item into account (see section 4). |
| `GET /api/outfits?status=saved` | `status` optional | `{ outfits }`, newest first |
| `GET /api/outfits/:id` | | `{ outfit }` |
| `PATCH /api/outfits/:id` | `{ status: "saved" }`, `"liked"`, `"suggested"`, or `{ status: "rejected", reason? }` | `{ outfit }`. Rejecting also records feedback. |
| `POST /api/outfits/:id/refine` | `{ kind: "swap", itemId }` or `{ kind: "guidance", text }` | Same as `POST /api/outfits`. The new outfits carry `parentOutfitId`. |

An **Outfit** is `{ id, request, name, reason, itemIds, items (full WardrobeItems, same order), status, parentOutfitId, createdAt }`. The collage uses `items`.

### Usage and account (built)
| Route | Get back |
| --- | --- |
| `GET /api/usage` | `{ itemsToday: { used, limit }, outfitRequestsToday: { used, limit }, dailyResetAt, aiPaused }` |
| `DELETE /api/account` | `{ deleted: true }`. Deletes the user's images, then their account, which removes all their rows, then signs them out. |

---

## 6. What the AI must return

The model's output is never trusted. Each reply is checked against a schema. If it fails, the call is retried once. If it fails again, the spec's fallback applies: empty tags for tagging, `ai_failed` for ranking. The shared helper `callWithValidation` does this. Extra fields the model adds are dropped; anything missing, mistyped or outside the vocabularies is rejected.

- **Tagging:** exactly the item tags from section 3.
- **Ranking pass 1 (tags only):** `{ outfits: [{ itemIds }] }`, 1 to 10 outfits.
- **Ranking pass 2 (with ~256 px thumbnails):** `{ outfits: [{ itemIds, name, reason }] }`, 1 to 5. The name is up to 40 characters and the reason up to 160.
- After parsing, `checkRankedOutfits` throws out any outfit that uses an item ID the model wasn't given, breaks the composition rule, or (when the request has an anchor item) leaves the anchor out.

**One retry covers both kinds of failure.** Some mistakes only show up with context: an invented item ID, a broken composition, a missing anchor. `callWithValidation` takes an optional `check` for these. It runs after the schema passes, and a failure there uses the same single retry, so there are never more than two calls. The pattern for ranking:

```ts
const result = await callWithValidation(RankingFinalOutputSchema, () => provider.pickFinal(input), {
  check: (out) => {
    const { rejected } = checkRankedOutfits(out.outfits, knownItems, { anchorItemId });
    return rejected.length ? rejected.map((r) => r.problem).join("; ") : null;
  },
  onCall: (call) => usage.recordAiCost(user.id, "ranking_final", call.costPence, call.provider),
  provider: "gemini",
});
if (!result.ok) throw new ApiException("ai_failed", "…");
```

`onCall` runs for every attempt, including one where the provider threw (a timed-out call may still be billed). For a thrown attempt `costPence` is empty, so the estimated cost is recorded.

Optional text the model returns as `""` (such as `fabric`) is read as empty rather than rejected.

The tests include recorded bad replies: an invented "accessory" category, a colour like "dusty heather", formality as a word, a multi-line description, truncated JSON, prose instead of JSON, made-up item IDs and a missing anchor.

---

## 7. Cost controls

| Setting | Value | Where |
| --- | --- | --- |
| New items per user per day | **40** [Decision] | `src/lib/usage/config.ts` |
| Outfit requests (including refinements) per user per day | **25** [Decision] | same |
| AI spend cap, all users together, per calendar month | **£5** (Gemini only) | same |
| Estimated cost per Gemini call, when the real cost isn't known | tagging 0.2p, shortlist 0.2p, final pick 0.5p [Decision] | same |
| Day and month boundaries | UK time (handles British Summer Time) | same |

Before starting work, every route that uses AI asks the usage guard whether it's allowed. The item cap is counted where tagging runs: in add-by-photo and in add-by-link step 2. Step 1 only checks it. After each Gemini call the route records the cost. Once the month's total reaches £5, AI features pause (`ai_paused`) until the 1st, but browsing the wardrobe and saved outfits still works. Real per-call costs should replace the estimates after the first tester week.

**Known limitation:** checking a cap and recording usage are two separate steps. Two requests sent at the same moment can both pass the check, so a user can go one or two over a daily cap, and the month can go slightly over £5. At tester scale this is a few pence at most, so it's accepted for now. A test pins the behaviour. Fixing it means an atomic check-and-record in the database.

---

## 8. Interfaces for the builder agents

| Interface | File | Built by |
| --- | --- | --- |
| `TaggingProvider.tagItem(image, productHints?)` | `src/lib/ai/types.ts` | ingestion (Gemini) |
| `RankingProvider.shortlist(...)` and `.pickFinal(...)` | `src/lib/ai/types.ts` | outfit-engine (Gemini) |
| `BackgroundRemover.removeBackground(Blob or ImageBitmap) → PNG Blob`, in the browser | `src/lib/images/types.ts` | ingestion |
| `ServerImageProcessor.inspect / stripMetadata / resize` | `src/lib/images/server.ts` | ingestion (link-import reuses it) |
| `UsageGuard` (caps and spend) | `src/lib/usage/` | built; others call it |
| `requireUser()` | `src/lib/auth/session.ts` | built; first line of every route |

Fakes for tests (no network): `FakeTaggingProvider`, `FakeRankingProvider` and `FakeBackgroundRemover`.

---

## 9. Setup Cheryl owns

Environment variables (see `.env.example`):

| Variable | What |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`: safe in the browser, RLS applies |
| `SUPABASE_SECRET_KEY` | `sb_secret_…`: server only, bypasses RLS. Only one server-only module reads it. |
| `NEXT_PUBLIC_SITE_URL` | The deployed URL, for links in sign-in emails |
| `GEMINI_API_KEY` | Gemini |
| `GLADRAGS_MOCK_MODE` | `true` only for local UI work. Refused on Vercel and in production builds. |
| `GLADRAGS_E2E` | `true` only for end-to-end test runs, to allow mock mode against `pnpm start` |

There's no background-removal key: it runs in the browser.

In the Supabase dashboard:
1. Run the migrations in `supabase/migrations/` in order (e.g. `supabase db push`).
2. Add yourself, then the testers, to `allowed_emails`.
3. Under Authentication → URL configuration, add the site URL and `<site>/auth/callback` to the redirect URLs.
4. Under Authentication → Email templates → Magic link, add the code to the email, e.g. `Or enter this code in the app: {{ .Token }}`. Optionally, point the link at `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`, which works in any browser.

---

## 10. Decisions for Cheryl

1. **Subcategories the spec didn't list.** Dress or jumpsuit: `dress`, `jumpsuit`. Shoes: `trainers`, `boots`, `sandals`, `heels`, `flats`, `loafers`, `smart_shoes`.
2. **Seasons**: spring, summer, autumn, winter, choosing one or more. **Warmth**: light, medium or warm.
3. **A fixed palette of 21 colours**, so filtering works and the model can't invent names. Each item has 1 to 3, with the first as the main colour.
4. **One top per outfit** in v1 (no layering).
5. **Deleting an item deletes the outfits that used it**, saved ones included.
6. **The allowlist lives in a database table**, enforced by the database, rather than in an env var.
7. **Three tables beyond the spec's four:** `usage_events` (caps and spend), `allowed_emails` (the allowlist) and `link_imports` (keeps add-by-link single-use and server-trusted).
8. **Cap values**: 40 items and 25 outfit requests per person per day; £5 a month for Gemini; the per-call cost estimates in section 7.
9. **Upload sizes**: original up to 1.5 MB, cut-out PNG up to 2.5 MB, both at most 1600 px. If PNG cut-outs prove too big on real phones, the options are to allow WebP cut-outs, or to upload to storage via short-lived signed upload URLs (the server would still need to check and strip the files afterwards, since users can't write to storage directly).
10. **Sign-in by code as well as link**, for the iPhone home-screen app. This needs the email template change in section 9.
11. **Signed image URLs** last 1 hour, or 10 minutes for the add-by-link product image.
12. **Caps can be overshot slightly** by requests sent at the same moment (section 7). Accepted at tester scale for now.
