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

The UI agents build against mock mode until the backend branches merge. Every route is now built. Mock data is only served when `GLADRAGS_MOCK_MODE=true`, which is refused on Vercel and in production builds, so a deployed build can never hand out the shared mock data.

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

Eight tables in Postgres: the spec's four (`users`, `items`, `outfits`, `outfit_feedback`), plus four the server needs: `usage_events`, `allowed_emails`, `link_imports` and `sign_in_attempts`. Row-level security (RLS) is on for every table. Signed-out visitors get nothing. A signed-in user can only see and change their own rows in the spec's four tables, and can read their own `usage_events`. The other three tables are server-only.

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

The database also enforces that the subcategory belongs to the category, that the values come from the fixed lists, that both images sit in the owner's own storage folder, and that no two items share an image key. Two saves of the same draft at the same moment therefore make one item; the other gets `bad_request` ("That item has already been saved").

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
**[Decision]** One row per capped action or Gemini call: `kind`, `cost_pence` and `provider`. The kinds are `item_ingest`, `outfit_request` and `link_fetch` (counted per user per day), and `tagging`, `ranking_shortlist` and `ranking_final` (Gemini calls, costed). It backs the daily caps and the £5/month cap (section 7). Only the server can write here, through the `reserve_usage` function, which checks the cap and records the row in one step. Users can't reset their own counters. When an account is deleted its rows are kept but unlinked, so the month's spend still counts.

### allowed_emails (the tester allowlist)
**[Decision]** The allowlist is a table, not an environment variable. A trigger on Supabase's auth table refuses to create an account for any other email, or to change an account's email to one that isn't listed. The change check only runs when the email really changes, so Supabase's routine updates to an account aren't affected. That holds even if someone calls Supabase's auth API directly with the public key, which an env-var check in our code couldn't stop. Only the server can read it.

Removing someone from `allowed_emails` stops new sign-ups with that address. It doesn't end sessions they already have, so to remove a tester, also delete or ban their auth user (section 9).

Add a tester in the Supabase SQL editor:

```sql
insert into public.allowed_emails (email, note) values ('someone@example.com', 'tester');
```

### link_imports (add-by-link in progress)
One row per add-by-link step 1: the source URL, the product data the server read, the stored image's key, and `tagged_at`. Step 2 claims the row in one statement, and only if it's unused, under an hour old, and the user's own. So each link can be tagged once, and step 2 uses what the server read rather than anything the phone sends back. Server-only.

### sign_in_attempts (sign-in rate limits)
One row per accepted sign-in request (a magic-link request or a code check): the action, whether the key is an email or an IP address, an HMAC-SHA-256 of that key made with the server-only `SIGN_IN_HASH_KEY`, and the time. The table is pseudonymous: it stores no email or IP address, and without the key its rows can't be matched to one, even by hashing guesses. The `reserve_sign_in_attempt` function checks the limits and records the attempt in one step (section 5, "Sign-in"). The daily cleanup deletes rows over a day old. Server-only.

### Image storage
Two private buckets, `originals` and `cutouts`. Object names are `<user id>/<random id>.<ext>`. Only the server writes images, after checking them and stripping EXIF. A signed-in user can read and delete objects in their own folder, but can't upload or change them directly. Images are served through signed URLs that expire: one hour for wardrobe and outfit images, and 10 minutes for the product image in add-by-link. Stored images carry `Cache-Control: private, max-age=600`, so shared caches never keep them and a browser keeps them for at most 10 minutes.

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
| forbidden | 403 | A POST, PATCH, PUT or DELETE sent from another website (see "Cross-site requests" below) |
| not_found | 404 | Doesn't exist, or isn't yours (deliberately the same answer) |
| unsupported_media_type | 415 | A route that takes JSON was sent something without `Content-Type: application/json` |
| daily_cap_reached | 429 | Per-user daily cap hit; `cap` says which and when it resets |
| rate_limited | 429 | Too many sign-in attempts; the message says how many minutes to wait |
| ai_paused | 503 | Monthly AI spend cap hit; adding and new outfits pause until next month |
| ai_failed | 502 | The model failed twice |
| server_misconfigured | 500 | Missing environment variables |
| not_implemented | 501 | Stub route called outside mock mode |
| internal | 500 | Anything else |

`cap.kind` is one of `items_per_day`, `outfit_requests_per_day`, `link_fetches_per_day` and `monthly_ai_spend`.

### Cross-site requests (CSRF)
The session cookie is `httpOnly` and `SameSite=Lax` (section 9), and on top of that:
- Any POST, PATCH, PUT or DELETE from another website is refused with `403 forbidden` before the route runs. A browser's `Sec-Fetch-Site: same-origin` is trusted, since pages can't forge it (that covers testing over the LAN from a phone, a proxy in front of the app, and `Origin: null`). Otherwise the `Origin` must be this site's (the request's own address, or `NEXT_PUBLIC_SITE_URL`), so a sibling subdomain (`same-site`) is still refused. With no `Origin`, a `Sec-Fetch-Site: cross-site` header is refused too.
- `POST /api/csp-report` is the one exception: browsers send CSP reports themselves, and a report changes nothing (section 9).
- Routes that take a JSON body require `Content-Type: application/json`, otherwise `415 unsupported_media_type`. A form on another website can't send that type.

"Built" below means it's a real implementation now. "Stub" means it validates input and serves mock data until the named agent replaces it.

### Sign-in (built)
| Route | Send | Get back |
| --- | --- | --- |
| `POST /api/auth/magic-link` | `{ email, next? }` | `{ sent: true }`, or `not_invited` |
| `POST /api/auth/verify-code` | `{ email, code, next? }`. The code is whatever Supabase emails: 6 digits by default, and the route accepts 6 to 10 because Supabase lets the length be changed. | `{ signedIn: true, next }` |
| `POST /api/auth/sign-out` | nothing | `{ signedOut: true }`. A plain HTML form post is redirected to /sign-in instead. |
| `GET /auth/callback?code=…` | (link from the default email) | Signs in, then redirects to `next` |
| `GET /auth/confirm?token_hash=…&type=email` | (link from a customised email) | A small "Continue signing in" page. It doesn't sign in by itself. |
| `POST /auth/confirm` | The form on that page (`token_hash`, `type`, `next`), from this site only | Signs in, then redirects to `next` |

`next` must be a path on this site, which prevents open redirects.

**Why `/auth/confirm` needs a tap:** a GET only shows the page, and signing in takes the page's form POST. Email scanners and link previews that open the link can't use up the one-time token, and another website can't sign someone in by loading the link. Typing the code is unchanged. The page uses the site-wide `Referrer-Policy: strict-origin-when-cross-origin`, so the form POST sends the page's URL, token included, as its `Referer`, but only to our own site. The token is single-use and that POST consumes it. (A page-level `no-referrer` was dropped: it makes browsers send `Origin: null` on the POST.) In mock mode the POST signs in without Supabase, like every mock sign-in.

**Rate limits.** Each of `magic-link` and `verify-code` allows **5 requests per email and 20 per IP address in any 15 minutes** [Decision]. After that the answer is `429 rate_limited`, with a message saying how many minutes to wait. The check comes before the allowlist check and counts every email the same way, so it reveals nothing about who's invited. The limit on code checks also stops anyone guessing a 6-digit code. The IP address is the one Vercel reports (`x-real-ip`, or the first `x-forwarded-for` entry). An IPv6 address counts by its /64 network, because one home or phone connection gets a whole /64. When no IP is known, only the per-email limit applies, so one person can't lock everyone out behind a shared address. The limit is per email, whoever sends the request, so someone who knows a tester's address can keep her out for 15 minutes at a time (decision 16).

**Why a code as well as a link:** on iPhone, an app added to the home screen doesn't share cookies with Safari. Tapping the emailed link signs you into Safari, not the app. Typing the code into the app works everywhere. For this, the Supabase email template needs `{{ .Token }}` added (see section 9). A minimal working sign-in page is at `/sign-in`, which wardrobe-ui will restyle.

### Wardrobe items (built; owner: ingestion)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/items?category=&colour=&occasion=&q=` | All filters optional; `q` searches descriptions | `{ items: WardrobeItem[] }` |
| `POST /api/items` | `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), tags, tagsEdited }` | `201 { item }` |
| `GET /api/items/:id` | | `{ item }` |
| `PATCH /api/items/:id` | `{ tags }` (all of them) | `{ item }` with `tagsEdited: true` |
| `DELETE /api/items/:id` | | `{ deleted: true }`. Also deletes its images and the outfits that used it. |

A **WardrobeItem** is `{ id, source, sourceUrl, originalUrl, cutoutUrl (or null), tags, tagsEdited, createdAt }`. Show `cutoutUrl` if there is one, otherwise `originalUrl`; the helper `displayImageUrl(item)` does this.

### Add by photo (built; owner: ingestion)
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
3. Check the cut-out is really a cut-out: it counts only if at least 1% of its pixels have alpha below 250, otherwise it's treated as missing. A cut-out wider or taller than its (upright) original is refused with `bad_request` on `cutout`. A corrupt or truncated image of either kind is `bad_request` on its field and isn't counted.
4. Strip EXIF data, including location, from both images.
5. Store both in the private buckets.
6. Tag the cut-out if there is one, otherwise the original.
7. Return `{ draft }`.

A **draft** is `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), originalUrl, cutoutUrl (or null), suggestedTags (or null) }`. If tagging fails twice, `suggestedTags` is null and the user fills the tags in. The user reviews the draft and saves it with `POST /api/items`.

**Why these sizes:** Vercel limits a request to 4.5 MB, and both files travel together. A 1600 px JPEG is usually under 1 MB. If a cut-out PNG comes out over 2.5 MB, the phone shrinks it until it fits. **[Decision]**

### Add by link, two steps (built; owner: link-import)
**Step 1:** `POST /api/items/link` with `{ url }`.

The server first checks the daily item cap and the AI pause, so a user at their limit isn't sent through step 2 for nothing. It doesn't count the item yet; no AI runs in this step. It then counts one **link fetch**, before fetching anything: at most **80 a day** per user (UK day), fallbacks and failures included, because every attempt makes the server fetch pages. Over that, the answer is `429 daily_cap_reached` with cap kind `link_fetches_per_day` (limit 80), separate from the 40 items. `GET /api/usage` doesn't report link fetches: the limit is a backstop against abuse that normal use won't reach. It then fetches the page, reads the product data, downloads the product image, resizes it, strips EXIF and stores it as the original. It records the import (source URL and product data) in `link_imports`, and returns either:
- `{ status: "ok", sourceUrl, originalImageKey, originalUrl, product: { title, brand, colour } }`. Here `originalUrl` is a signed URL that lasts 10 minutes. `product` is for display only.
- `{ status: "needs_screenshot", reason, sourceUrl, message }`. The reason is `fetch_blocked`, `no_product_data` or `no_image`. The phone asks for a screenshot and sends it through add-by-photo with `sourceUrl`, so the item keeps its link.

Scraped product text is cleaned before it's used: line breaks are flattened to spaces, control and bidi characters removed, it's trimmed and length-limited (title 200, brand 80, colour 60 characters) without splitting an emoji, and blanks become empty.

**Fetching user-supplied links safely (SSRF).** The page and product images are fetched by `src/lib/link-import/safe-fetch.ts`:
- http(s) only, on the default ports; no user name or password in the URL; no `localhost`, `.local`/`.internal`-style or single-word host names.
- The server resolves DNS itself, and every address returned must be public (no loopback, private, link-local, carrier-grade NAT, cloud metadata, IPv4-mapped, NAT64 or other special ranges). The connection is pinned to those checked addresses, so DNS rebinding can't swap them.
- Every redirect is checked again (at most 3), and an https→http redirect is refused.
- Time limits (5 s idle, 10 s for the page, 12 s per image) and size limits (2 MB page, 10 MB image, counted after decompression). No cookies or credentials, and an honest `GladRags` User-Agent; shops that block it go to the screenshot fallback.

**Step 2:** the phone loads `originalUrl`, cuts the item out, and calls `POST /api/items/link/cutout`, as a multipart form:

| Field | Required | Rules |
| --- | --- | --- |
| `meta` | yes | JSON text: `{ originalImageKey }` from step 1. Anything else in it is ignored. |
| `cutout` | no | PNG, as for add-by-photo. Leave it out if removal failed. |

The server:
1. Checks the daily item cap and the AI pause.
2. Finds the import: it must be the user's, unused, and less than an hour old. Otherwise the answer is `404 not_found`, meaning "paste the link again".
3. Checks and stores the cut-out first, so a rejected cut-out (`bad_request` on `cutout`) leaves the import usable for another try.
4. Claims the import in one database statement. **Each import can be tagged only once**, so replaying step 2 can't run Gemini again; if the claim fails, the stored cut-out is removed.
5. Counts the item against the daily cap.
6. Tags the cut-out (or the original), using the product title, brand and colour **it stored in step 1** as hints. It never uses data the phone sends back.
7. Returns `{ draft }`, exactly as add-by-photo does.

An import that's never finished leaves an unused image in storage. Two cleanup jobs handle this: `cleanUpOrphanedImages` (src/lib/ingestion/cleanup.ts) deletes images over 24 hours old that no item or open import uses, and `cleanUpOldLinkImports` (src/lib/link-import/cleanup.ts) deletes `link_imports` rows over 7 days old. Both run daily from `GET /api/cron/cleanup` (see "Scheduled jobs" below).

Android can "share" a product page straight to the installed app; it opens `/add/link?url=…` (a wardrobe-ui page). iPhone doesn't support this, so users paste the link.

### Outfits (built; owner: outfit-engine)
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

### Scheduled jobs (built)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/cron/cleanup` | `Authorization: Bearer <CRON_SECRET>` | `{ imagesChecked, orphanedImagesDeleted, linkImportsDeleted, signInAttemptsDeleted }` (counts only) |

Vercel Cron calls it once a day at 03:17 UTC (`vercel.json`). **Vercel runs cron jobs on production deployments only**, never on previews, so until the app has a production deployment the cleanup doesn't run on its own (it can be called by hand with the secret). It deletes images over a day old that no item or open link import uses, `link_imports` rows over 7 days old, and `sign_in_attempts` rows over a day old. The secret is compared in constant time. A wrong or missing header gets `401 unauthorized`. If `CRON_SECRET` isn't set, is blank, or has spaces or a newline around it (which no header could ever match), the answer is `500 server_misconfigured` and nothing runs. No user is involved, so it isn't behind sign-in. Neither the response nor the logs include keys, emails or other user data.

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
  ...usage.meterAiCalls(user.id, "ranking_final", "gemini"), // beforeCall reserves the cost, onCall settles it
  provider: "gemini",
});
if (!result.ok) throw new ApiException("ai_failed", "…");
```

`beforeCall` runs before every attempt and reserves that call's estimated cost against the £5 cap. If the cap is reached it throws (`ai_paused`) and no call is made. `onCall` runs after every attempt, including one where the provider threw (a timed-out call may still be billed), and replaces the estimate with the real cost when the provider reports one. For a thrown attempt `costPence` is empty, so the estimate stands.

Optional text the model returns as `""` (such as `fabric`) is read as empty rather than rejected.

The tests include recorded bad replies: an invented "accessory" category, a colour like "dusty heather", formality as a word, a multi-line description, truncated JSON, prose instead of JSON, made-up item IDs and a missing anchor.

---

## 7. Cost controls

| Setting | Value | Where |
| --- | --- | --- |
| New items per user per day | **40** [Decision] | `src/lib/usage/config.ts` |
| Outfit requests (including refinements) per user per day | **25** [Decision] | same |
| Add-by-link page fetches (step 1, fallbacks included) per user per day | **80** [Decision] | same |
| AI spend cap, all users together, per calendar month | **£5** (Gemini only) | same |
| Estimated cost per Gemini call, when the real cost isn't known | tagging 0.2p, shortlist 0.2p, final pick 0.5p [Decision] | same |
| Day and month boundaries | UK time (handles British Summer Time) | same |

Before starting work, every route that uses AI asks the usage guard whether it's allowed (`assertCanStart`, a quick check that counts nothing). The item cap is counted where tagging runs: in add-by-photo and in add-by-link step 2. Step 1 only checks it, and counts a link fetch instead. Once the month's total reaches £5, AI features pause (`ai_paused`) until the 1st, but browsing the wardrobe and saved outfits still works. Real per-call costs should replace the estimates after the first tester week.

**Checking and counting are one atomic step.** Counting an action (`reserveAction`) and reserving a Gemini call's cost (`reserveAiCost`, or `meterAiCalls` for `callWithValidation`) each go through one database function, `reserve_usage`. It locks (per user for the daily caps, and once for everyone for spend), counts, and records the row only if the cap allows it. Requests sent at the same moment queue behind each other, so a burst can't overshoot a daily cap or the monthly cap. `pnpm db:verify` proves this with 30 calls fired at once. The check is "reached, not approached": a call is allowed while the month is under £5.

**How far past £5 the month can go.** Each call reserves its estimate first. When it returns, the real cost replaces the estimate. A real cost is only used if it's a number of zero or more, and it's recorded at most at **3 times the estimate** (a log line says so when that happens, which means the estimates need raising). So the month can end up over £5 by at most one call's estimate (0.5p), plus up to 2 × its estimate (1p at most) for each call that was already running when the cap was reached. At tester scale that's a few pence at worst.

If AI pauses after a request has been counted but before its model call (another request reached the cap in between), the user gets nothing, so the count is given back: in add-by-photo, in outfit requests and refinements, and in add-by-link step 2, which also reopens the import so the link needn't be pasted again (it still expires an hour after step 1).

In add-by-link step 2 the item is counted before the import is claimed. If the claim then fails (the link was already added, or a double tap lost the race), the count is given back.

---

## 8. Interfaces for the builder agents

| Interface | File | Built by |
| --- | --- | --- |
| `TaggingProvider.tagItem(image, productHints?)` | `src/lib/ai/types.ts` | ingestion (Gemini) |
| `RankingProvider.shortlist(...)` and `.pickFinal(...)` | `src/lib/ai/types.ts` | outfit-engine (Gemini) |
| `BackgroundRemover.removeBackground(Blob or ImageBitmap) → PNG Blob`, in the browser | `src/lib/images/types.ts` | ingestion |
| `ServerImageProcessor.inspect / stripMetadata / resize / hasTransparency / prepareForModel` | `src/lib/images/server.ts` | ingestion (link-import reuses it, plus `checkUploadedCutout`, `cleanImage` and `suggestTags` from `src/lib/ingestion`) |
| `UsageGuard` (caps and spend): `assertCanStart`, `reserveAction`, `meterAiCalls` | `src/lib/usage/` | built; others call it |
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
| `GEMINI_MODEL` | Optional. Gemini model for tagging and ranking; defaults to `gemini-3.8-flash`. Must have known prices (`GEMINI_MODEL_PRICES`), otherwise startup fails with a config error. |
| `GLADRAGS_MOCK_MODE` | `true` only for local UI work. Refused on Vercel and in production builds. |
| `GLADRAGS_E2E` | `true` only for end-to-end test runs, to allow mock mode against `pnpm start` |
| `CRON_SECRET` | A long random value (e.g. `openssl rand -hex 32`). Vercel sends it to the daily cleanup job; without it the job refuses to run. Set it in Vercel for Production (cron jobs only run there); Preview too if you want to call the job by hand on a preview. |
| `SIGN_IN_HASH_KEY` | Server only. At least 32 random characters (e.g. `openssl rand -hex 32`). The key for the pseudonymous sign-in attempt hashes. Without a usable one, sign-in answers `500 server_misconfigured` outside mock mode and tests. Changing it only resets the 15-minute limits. Set it in Vercel for Production and Preview. |

There's no background-removal key: it runs in the browser.

In the Supabase dashboard:
1. Run the migrations in `supabase/migrations/` in order (e.g. `supabase db push`).
2. Add yourself, then the testers, to `allowed_emails`.
3. Under Authentication → URL configuration, add the site URL and `<site>/auth/callback` to the redirect URLs.
4. Under Authentication → Email templates → Magic link, add the code to the email, e.g. `Or enter this code in the app: {{ .Token }}`. Optionally, point the link at `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`, which works in any browser (it opens a page with a "Continue signing in" button).
5. Under Authentication → Providers → Email (or Sign In / Providers), set the email OTP expiry to about 10 minutes (600 seconds). The default is an hour.
6. Set up custom SMTP (Authentication → Emails → SMTP settings) before testers join. Supabase's built-in email service only sends to members of the project's team, and only a few emails an hour.
7. To remove a tester: delete their row from `allowed_emails` **and** delete or ban their user under Authentication → Users. Removing the allowlist row alone doesn't end sessions they already have.

### Browser security
- Session cookies are `httpOnly` (page scripts can't read them), `SameSite=Lax`, and `Secure` in production. Nothing in the browser reads the session; the UI only calls our API routes.
- Every response sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), geolocation=(), microphone=()` and `X-Frame-Options: DENY`, and no `X-Powered-By`.
- A Content Security Policy is sent as **Report-Only**: browsers report anything it would block, but block nothing. It allows only this site, plus Supabase for images and API calls, `blob:` and `data:` images, WebAssembly for the background remover, and inline scripts and styles (Next.js and the UI use them). The e2e suite checks our own pages raise no reports. **It should move to enforcing (`Content-Security-Policy`) after Cheryl's test**, once real use shows no reports.

**Checking for reports.** Browsers send reports to `POST /api/csp-report` (`report-uri`, and `report-to` through the `Reporting-Endpoints` header). Each one is logged as `CSP report` with two fields only: the directive (e.g. `img-src`) and where the blocked thing came from, as an origin (`https://evil.example`) or a keyword (`inline`, `eval`, `data`, `blob`). No full URLs, pages or user data are logged. To check: in the Vercel dashboard open the project → Logs, pick the deployment and time range, and search for `CSP report`. None after a few days of real use means it's safe to enforce. Reports can arrive a minute or so late (browsers batch them). The route refuses bodies over 16 KB and logs at most 60 reports a minute per server instance, so junk can't flood the logs.

**Vercel's preview toolbar.** On preview deployments Vercel injects its feedback toolbar from `https://vercel.live`, which the policy doesn't allow, so previews will log `CSP report` lines blocking `https://vercel.live`. Those aren't ours. Recommendation: turn the toolbar off for this project (Project → Settings → General → Vercel Toolbar, set Preview to off) while checking reports, rather than allowing `vercel.live` in the policy. Production deployments don't get the toolbar.

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
12. ~~Caps can be overshot by requests sent at the same moment.~~ Fixed: checking and counting are now one atomic database step (section 7).
13. **Link fetches have their own cap**: 80 a day per user, fallbacks included, reported as `link_fetches_per_day` (section 5).
14. **Sign-in rate limits**: 5 per email and 20 per IP address per 15 minutes, for each sign-in route (section 5).
15. **The `/auth/confirm` link needs one tap** ("Continue signing in") before it signs in (section 5).
16. **A tester can be locked out by someone who knows her email.** The sign-in limits count per email, whoever sends the request, so 5 junk requests block that email for 15 minutes (on each sign-in route), from any IP. That's the trade-off for stopping code guessing. If it's a problem in practice, a mitigation is to count only **failed** code checks per email on `verify-code` (successful ones and magic-link requests would then not lock anyone out), at the cost of a little more code.
17. **AI costs settle at most 3x their estimate**, which bounds how far past £5 the month can go (section 7).
