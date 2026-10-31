# GladRags contracts

What the foundations branch fixes in place for every other agent: the data model, the shared types, and what each API route accepts and returns. Cheryl approved the first version at checkpoint 2. Milestone 5 (the changes from Cheryl's own test) added review flags, outfit gaps, favourite shops, shop search and order emails; those parts are marked **(M5)**.

The code is the precise version: Zod schemas in `src/contracts/`, SQL in `supabase/migrations/`. This document says the same thing in plain language. If they ever disagree, the code is wrong or this document is stale, so fix one of them.

**Decisions for Cheryl** are marked **[Decision]**. They're collected at the end too: section 10 for the first round, section 11 for milestone 5.

---

## 1. How the pieces fit

- One Next.js app. Pages and API routes live in `src/app/`.
- Supabase holds auth, the Postgres database and the image storage.
- Gemini does tagging, outfit ranking, reading order emails and (with Google Search) finding gap items in shops, behind interfaces in `src/lib/ai/`.
- **Background removal runs in the user's browser**, behind an interface in `src/lib/images/`. There's no hosted service and no cost. **(M5)** It happens the first time a collage needs an item, not when the item is added.
- **(M5)** An inbound email service (Cheryl's choice) posts forwarded order emails to a webhook, behind an interface in `src/lib/email/`.
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
| `mock-gaps` | **(M5)** Outfits: canned outfits that each have a shoes gap, with `missingCategories: ["shoes"]` |

Where to put them:
- Add by photo: in the original file's name, e.g. `shirt-mock-no-tags.jpg`.
- Add by link: anywhere in the URL, e.g. `https://shop.example.com/p?x=mock-ai-paused`.
- Outfits and refinements: in the guidance or the custom style text.

On top of that, a link whose host contains `blocked`, `nodata` or `noimage` gives the screenshot fallback, with that reason.

**Milestone 5 in mock mode.** Until the builders replace the stubs:
- A batch add (`saveForReview`) saves the item as "to review", so `GET /api/items?needsReview=true` lists it. `mock-no-tags` makes it come back as a draft instead.
- An outfit request with `includeShopItems: true` (and no anchor), or `mock-gaps` in the guidance, returns three canned outfits with a shoes gap. "Find in my shops" on one gives three made-up products per gap from the favourite shops (the third has no image), and a product can then be picked.
- Settings start with Next, M&S and New Look, and the forwarding address `0123456789abcdef0123456789abcdef@inbound.gladrags.test` (or your `INBOUND_EMAIL_DOMAIN`).
- To get an order email in, post the normalised email straight to the webhook (no signature in mock mode). From the mock user's address to the mock forwarding address, with passing checks, it adds two "to review" items, one of them without a picture (`needsPhoto`):

```sh
curl -X POST localhost:3000/api/inbound/email -H 'content-type: application/json' -d '{
  "messageId": "<1@mail.example>", "from": "mock.user@gladrags.test",
  "to": ["0123456789abcdef0123456789abcdef@inbound.gladrags.test"],
  "subject": "Fwd: Your order", "text": "Order", "html": null,
  "receivedAt": "2026-10-30T10:00:00Z",
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
  "spam": { "isSpam": false, "score": 0 } }'
```

A different `from`, or failing checks, records a failed import instead.

---

## 2. Data model

Ten tables in Postgres: the spec's four (`users`, `items`, `outfits`, `outfit_feedback`), the spec's user settings (`user_settings`, **(M5)**), plus five the server needs: `usage_events`, `allowed_emails`, `link_imports`, `sign_in_attempts` and `email_imports` **(M5)**. Row-level security (RLS) is on for every table. Signed-out visitors get nothing. A signed-in user can only see and change their own rows in the spec's four tables, can read their own `usage_events` and `email_imports`, and can read their own `user_settings` and change only its favourite shops. The other three tables are server-only.

**(M5) Applying migrations.** Migration 7 (`20261030000007_milestone5.sql`) is safe to run twice: it uses "if not exists", "create or replace" and drop-then-create throughout, and runs in one transaction, so a failure part-way changes nothing. `pnpm db:verify` applies it twice to prove it. Every migration from 7 on must be written the same way. **Apply it before deploying code from this round**: the new code reads the new columns.

### users
| Field | Notes |
| --- | --- |
| id | Same as the Supabase auth user ID |
| email | Lower-cased |
| display_name | Defaults to the part of the email before the @. Users can change only this field. |
| created_at | |

A row is created automatically when someone signs in for the first time, and with it a `user_settings` row. Deleting the auth user deletes everything they own.

### items
| Field | Notes |
| --- | --- |
| id, user_id, created_at | |
| source | `photo`, `link` or `email` **(M5)** |
| source_url | Required when source is `link` (screenshot fallback included). For `email`, the product link if the email had one. |
| original_image_key | The resized photo or product image. Always present. For an email item without a usable picture, the server stores a placeholder image here and sets `needs_photo`. |
| cutout_image_key | The transparent cut-out, for collages. **(M5) Usually empty when the item is added:** the phone cuts the item out the first time a collage needs it, and uploads it then. Stays empty if removal fails; collages then use the original. |
| category, subcategory, colours[], pattern, formality, seasons[], warmth, occasions[], fabric, description | The tags; see section 3 |
| tags_edited | True if the user changed any auto-filled tag. This measures "tagging right for 4 in 5 items". |
| needs_review | **(M5)** True for items added in a batch (several photos, several links, or an order email) that the user hasn't confirmed yet. Default false. Unreviewed items are still used for outfits. |
| needs_photo | **(M5)** True for an email item saved without a usable picture: the user is asked to add one. Default false. |

The database also enforces that the subcategory belongs to the category, that the values come from the fixed lists, that both images sit in the owner's own storage folder, and that no two items share an image key. Two saves of the same draft at the same moment therefore make one item; the other gets `bad_request` ("That item has already been saved").

### outfits
| Field | Notes |
| --- | --- |
| id, user_id, created_at | |
| request | What was asked for: `{ style, guidance, anchorItemId, includeShopItems }`. Outfits saved before milestone 5 have no `includeShopItems`, which reads as false. |
| name, reason | From the model, e.g. "Easy office" / "Navy and tan keep this smart without being stiff" |
| item_ids[] | The owned items: **(M5)** 1 to 4 (was 2 to 4) |
| gaps | **(M5)** The slots the wardrobe doesn't fill, as a JSON list (section 4, "Gaps"). Empty for a complete outfit. At most 3, and items plus gaps make 2 to 4 pieces. |
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

### user_settings (M5)
One row per user, created with their profile (and, for existing users, by the migration).

| Field | Notes |
| --- | --- |
| user_id | The owner |
| favourite_shop_ids[] | 1 to 12 shop IDs from the fixed list (section 4, "Favourite shops"). Default: `next`, `marks_and_spencer`, `new_look`. The only field the user can change. |
| forwarding_token | The private part of the user's order-email forwarding address: 32 random hex digits (122 bits). Unique. Users can read it but not choose it; the database function `reset_forwarding_token()` gives the signed-in user a new one. |
| updated_at | |

**[Decision]** A separate table rather than columns on `users`, so `users` keeps its "change only your display name" rule and the token can be looked up by the server alone.

### email_imports (M5)
One row per forwarded email that reached a user's forwarding address. **It never holds the email**: no sender, recipients, subject or body. Only what the user sees, plus a hash to ignore a redelivered webhook.

| Field | Notes |
| --- | --- |
| id, user_id, created_at | |
| message_hash | SHA-256 of the email service's message ID. One row per user per hash. |
| received_at | When the service received it |
| shop_name, order_date | As the model read them; either can be empty |
| status | `processing`, `done` or `failed` |
| item_count, skipped_count | Items added ("to review"), and clothing lines found but not added |
| error | Why it failed or skipped some: `sender_not_allowed`, `failed_checks`, `no_items_found`, `daily_cap_reached`, `ai_paused`, `ai_failed` or `internal`. Required when `failed`. |

Only the server writes here; users can read their own.

### usage_events (addition to the spec)
**[Decision]** One row per capped action or Gemini call: `kind`, `cost_pence` and `provider`. The kinds counted per user per day are `item_ingest`, `outfit_request`, `link_fetch`, and **(M5)** `email_import` and `shop_search`. The costed Gemini kinds are `tagging`, `ranking_shortlist`, `ranking_final`, and **(M5)** `email_extraction` and `shop_grounding`. It backs the daily caps and the £5/month cap (section 7). Only the server can write here, through the `reserve_usage` function, which checks the cap and records the row in one step. Users can't reset their own counters. When an account is deleted its rows are kept but unlinked, so the month's spend still counts.

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

**(M5)** The wardrobe shows the original; only collages use cut-outs. For an email item without a usable picture the server stores a plain placeholder picture as its original, so every item still has one and nothing else changes; `needsPhoto` tells the UI to ask for a photo.

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

Every text field that can reach a model prompt (tags, guidance, custom styles, scraped product data, gap descriptions, and what the model reads from order emails) is a single line with a length limit. That stops anyone adding new lines that look like separate prompt sections. It does **not** stop prompt injection on its own: "Ignore previous instructions" fits on one line. The prompts themselves must treat user and scraped text as data, and the outputs are checked against these schemas, which limits what a successful injection could do.

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
Either **one top and one bottom**, or **one dress or jumpsuit**. Plus **exactly one pair of shoes**, plus **at most one piece of outerwear**. That makes 2 to 4 pieces.

**(M5)** Each piece is either an **owned item** or a **gap** (below), and **at least one piece must be owned**. The anchor item, if there is one, is always an owned piece. So a wardrobe with a single top can still get outfits: the top, plus gaps for a bottom and shoes.

**[Decision]** v1 has no layering, so it's one top only (no shirt under a jumper). This is easy to relax later.

The rule is one shared function, `checkComposition(ownedCategories, gapCategories)`. The outfit engine uses it both when generating candidates and when checking the model's picks. Called with owned categories only, it behaves exactly as before.

### Outfit request
- `style`: a preset or custom text (required)
- `anchorItemId`: build every outfit around this item (optional)
- `guidance`: e.g. "no heels" (optional, one line, up to 200 characters)
- `count`: 3 to 5, default 4
- `includeShopItems` **(M5)**: "Include items from my shops" (optional, default false). Outfits may then include **one** suggested shop item even where the wardrobe could fill the slot.

### Gaps (M5)
A gap is a slot the wardrobe doesn't fill. The model describes the item that would complete the look:

| Field | Notes |
| --- | --- |
| category | Which slot: one of the five categories. At most one gap per category, and never in a slot an owned item fills. |
| subcategory | Optional, from that category's list (e.g. `trainers`) |
| colours | 1 to 3 from the fixed palette, main colour first |
| description | One line, up to 120 characters, e.g. "White leather trainers". Shown on the collage placeholder and used for the shop search. |
| shopResults | What "Find in my shops" last found: up to 3 products. Empty until searched. |
| searchedAt | When it was last searched, or empty |
| shopProduct | The product the user picked from shopResults, or empty. The collage shows its image in the slot. |

A **shop product** is `{ shopId, title, url, priceText, imageUrl }`. The server fills it from the product page itself (title, price as the page shows it, e.g. "£35", and image), after checking the page exists, never from what the model said. The `url` must be on that shop's own website.

When gaps are allowed (checked by the shared `checkRankedOutfits`). Gaps are about **slots**, not categories **[Decision, orchestrator]**:
- **A required slot the wardrobe can't fill can always be a gap.** The required slots are the outfit's structure: a top and a bottom, or a dress or jumpsuit, plus shoes. "Can't fill" is the shared `missingCategoriesForOutfits` on the wardrobe the engine could use for this request (after the style filter), taking the anchor into account. If the wardrobe has no shoes, every outfit gets a shoes gap. If it has no separates and no dress, a single dress gap may stand in for the missing top and bottom.
- **Every other gap is a shop-item gap**: a slot the wardrobe could fill (for example a dress gap when the wardrobe has tops and bottoms), and **any outerwear gap**, because outerwear is optional and never required. Shop-item gaps are allowed only when the request has `includeShopItems`, and then at most one per outfit (`MAX_SHOP_ITEM_GAPS` = 1).
- Example refused: a wardrobe with tops, bottoms and shoes; an outfit of owned shoes plus a dress gap; shop items off.
- Every outfit keeps at least one owned item. Complete outfits from the wardrobe are preferred over ones with gaps (the engine's ordering).

### Favourite shops (M5)
A fixed list of UK high-street shops, each with the website domains its product pages live on. A link counts as a shop's if it's `https`, and its host is one of those domains or a subdomain (`www.next.co.uk`, `www2.hm.com`). `shopForUrl(url, shopIds)` checks it.

| ID | Name | Domains |
| --- | --- | --- |
| next | Next | next.co.uk |
| marks_and_spencer | M&S | marksandspencer.com |
| new_look | New Look | newlook.com |
| john_lewis | John Lewis | johnlewis.com |
| river_island | River Island | riverisland.com |
| zara | Zara | zara.com |
| hm | H&M | hm.com |
| uniqlo | Uniqlo | uniqlo.com |
| asos | ASOS | asos.com |
| mango | Mango | mango.com |
| matalan | Matalan | matalan.co.uk |
| fatface | FatFace | fatface.com |

New users start with **Next, M&S and New Look** (Cheryl's choice). Each user picks at least one. **[Decision]** Primark is left out: it has no UK online shop to link to. The domains are from knowledge, not checked live (this environment can't reach the shops); the link-import fetcher will show quickly if one is wrong. Adding a shop is a contract change plus a migration (the database checks the IDs).

### When outfits can't be made, and missing categories
**(M5)** A missing category no longer stops outfits: the slot becomes a gap. A successful response lists the categories the wardrobe is missing for this request, so the UI can say "Add shoes to complete these outfits":

`{ status: "ok", outfits, missingCategories }`, where `missingCategories` comes from the shared `missingCategoriesForOutfits(present, anchorCategory)` (empty when the wardrobe has everything). With an anchor item, the list is about outfits that include the anchor: building around a top with no bottoms gives `["bottom"]`, even if there's a dress, because the dress can't be worn with the top.

Not getting any outfits isn't an error either. The response says `incomplete_wardrobe`, with a reason:
- `empty_wardrobe` **(M5)**: no items at all, so no outfit can have an owned piece. The UI points to the get-started checklist.
- `nothing_fits`: there are items, but none can start an outfit for this style or anchor.
- `missing_category`: **legacy**, from before gaps (no combination exists without gaps; it lists what to add). The engine stops returning it in this round; it stays valid until the engine and outfit UI branches have both merged, and is then removed.

---

## 5. API routes

All routes are under `/api` and return JSON. Every route except the sign-in ones, the scheduled job and **(M5)** the inbound email webhook needs a signed-in user. Errors always look like this:

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

`cap.kind` is one of `items_per_day`, `outfit_requests_per_day`, `link_fetches_per_day`, **(M5)** `emails_per_day`, `shop_searches_per_day`, and `monthly_ai_spend`.

### Cross-site requests (CSRF)
The session cookie is `httpOnly` and `SameSite=Lax` (section 9), and on top of that:
- Any POST, PATCH, PUT or DELETE from another website is refused with `403 forbidden` before the route runs. A browser's `Sec-Fetch-Site: same-origin` is trusted, since pages can't forge it (that covers testing over the LAN from a phone, a proxy in front of the app, and `Origin: null`). Otherwise the `Origin` must be this site's (the request's own address, or `NEXT_PUBLIC_SITE_URL`), so a sibling subdomain (`same-site`) is still refused. With no `Origin`, a `Sec-Fetch-Site: cross-site` header is refused too.
- `POST /api/csp-report` is the one exception: browsers send CSP reports themselves, and a report changes nothing (section 9).
- **(M5)** `POST /api/inbound/email` is checked too, and passes because the email service sends no `Origin`. It doesn't rely on that: it has no session, and authenticates by the service's signature (see "Order emails").
- Routes that take a JSON body require `Content-Type: application/json`, otherwise `415 unsupported_media_type`. A form on another website can't send that type.

"Built" below means it's a real implementation now. "Stub" means it validates input and serves mock data until the named agent replaces it.

**(M5) Stubs in this round.** New routes, and new options on existing routes, work in mock mode now and answer `501 not_implemented` outside it until their builder ships them. Each says which agent builds it. Existing behaviour is unchanged.

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
| `GET /api/items?category=&colour=&occasion=&q=&needsReview=` | All filters optional; `q` searches descriptions. **(M5)** `needsReview=true` lists only items still "to review" (the review list; its length is the banner's N); `false` only reviewed ones. *Stub for the filter.* | `{ items: WardrobeItem[] }` |
| `POST /api/items` | `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), tags, tagsEdited }`. `source` is `photo` or `link`. | `201 { item }`, never "to review" (the user just reviewed it) |
| `GET /api/items/:id` | | `{ item }` |
| `PATCH /api/items/:id` | `{ tags }` (all of them), **(M5)** or `{ reviewed: true }` to confirm the suggested tags as they are, or both. *Stub for `reviewed` alone.* | `{ item }`. Sending `tags` sets `tagsEdited: true`. **(M5)** Every PATCH clears `needsReview`. |
| `POST /api/items/reviewed` | **(M5)** `{ itemIds }` (1 to 100): "Confirm all" in the review list. IDs that aren't the user's are ignored. *Stub (ingestion).* | `{ updated }`: how many were the user's |
| `DELETE /api/items/:id` | | `{ deleted: true }`. Also deletes its images and the outfits that used it. |
| `PUT /api/items/:id/cutout` | **(M5)** Multipart, file `cutout` (below). *Stub (ingestion).* | `{ item }` with its `cutoutUrl` |
| `PUT /api/items/:id/photo` | **(M5)** Multipart, file `original` (below). *Stub (ingestion).* | `{ item }` with `needsPhoto: false` |

A **WardrobeItem** is `{ id, source, sourceUrl, originalUrl, cutoutUrl (or null), tags, tagsEdited, needsReview, needsPhoto, createdAt }`. `source` is `photo`, `link` or **(M5)** `email`. **(M5)** The wardrobe grid and item screens show `originalUrl`. Collages show `cutoutUrl` if there is one, otherwise `originalUrl`; the helper `collageImageUrl(item)` does this (`displayImageUrl` is the same helper under its old name).

**Cut-out for an existing item (M5).** The first time a collage needs an item without a cut-out, the phone cuts it out from `originalUrl` and sends it with `PUT /api/items/:id/cutout`, file `cutout`: PNG with transparency, ≤ 1600 px, ≤ 2.5 MB. The server applies the same checks as the old add-time cut-out (real type from the bytes, transparency, no wider or taller than the item's original, EXIF stripped), stores it, and returns the item. A newer cut-out replaces an older one (two phones can race), and the old file is deleted. No AI, so no cap. If removal fails on the phone, it sends nothing and the collage uses the original.

**Adding a photo later (M5).** For an email item saved without a picture (`needsPhoto`), `PUT /api/items/:id/photo`, file `original`, checked like add-by-photo, replaces the placeholder, removes any cut-out, clears `needsPhoto` and marks the item "to review" so the user can check the tags against the photo. The tags aren't re-run (no AI, no cap). **[Decision]**

### Add by photo (built; owner: ingestion)
On the phone:
1. Resize the photo to at most 1600 px on its longest side, and re-encode it as JPEG. iPhones take HEIC photos by default, and the server rejects HEIC.
2. Upload. **(M5)** No background removal at this stage: it happens when a collage first needs the item.

`POST /api/items/photo`, sent as a multipart form, not JSON:

| Field | Required | Rules |
| --- | --- | --- |
| `original` | yes | JPEG, PNG or WebP; ≤ 1600 px; ≤ 1.5 MB |
| `cutout` | no | **(M5) Deprecated.** PNG with transparency; ≤ 1600 px; ≤ 2.5 MB. Still accepted and checked as before, so the current add screen keeps working until the new one ships; then it's removed. |
| `sourceUrl` | no | Set for the screenshot fallback from add-by-link, so the item keeps its link |
| `saveForReview` | no | **(M5)** `true` for a batch add (several photos): save the item straight away as "to review" instead of returning a draft. Default `false`. *Stub outside mock mode.* |

On the server:
1. Check the daily item cap, and count this item: tagging happens in this request.
2. Check each file's real type from its bytes, not the name the phone gives it. HEIC, GIF and anything else are refused. Check size and pixel dimensions too.
3. If a cut-out was sent: check it's really a cut-out: it counts only if at least 1% of its pixels have alpha below 250, otherwise it's treated as missing. A cut-out wider or taller than its (upright) original is refused with `bad_request` on `cutout`. A corrupt or truncated image of either kind is `bad_request` on its field and isn't counted.
4. Strip EXIF data, including location.
5. Store the image(s) in the private buckets.
6. Tag the original (or the cut-out, if one was sent).
7. Return `{ draft }`, or for a batch add:
   - `{ status: "saved", item }`: saved with the suggested tags and `needsReview: true`.
   - `{ status: "draft", draft }`: tagging failed twice, so there were no tags to save it with. The review list shows it as a draft to fill in and save with `POST /api/items`, as for a single add.

A **draft** is `{ source, sourceUrl, originalImageKey, cutoutImageKey (or null), originalUrl, cutoutUrl (or null), suggestedTags (or null) }`. If tagging fails twice, `suggestedTags` is null and the user fills the tags in. The user reviews the draft and saves it with `POST /api/items`. **(M5)** `cutoutImageKey` and `cutoutUrl` are null unless an older client sent a cut-out.

**Several photos at once (M5).** The phone uploads them one after another (not in parallel), each with `saveForReview=true`. Each one counts against the daily item cap; when the cap is reached the rest get `429 daily_cap_reached` and the phone stops.

**Why these sizes:** Vercel limits a request to 4.5 MB. A 1600 px JPEG is usually under 1 MB. If a cut-out PNG comes out over 2.5 MB, the phone shrinks it until it fits. **[Decision]**

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

The same fetcher is used for order-email product images and pages, and to check shop search results (M5).

**Step 2:** **(M5)** the phone calls `POST /api/items/link/cutout` straight away (the path keeps its old name; no cut-out is needed any more), as a multipart form:

| Field | Required | Rules |
| --- | --- | --- |
| `meta` | yes | JSON text: `{ originalImageKey }` from step 1, plus **(M5)** `saveForReview: true` for a batch add (several links). Anything else in it is ignored. |
| `cutout` | no | **(M5) Deprecated**, as for add-by-photo. Leave it out. |

The server:
1. Checks the daily item cap and the AI pause.
2. Finds the import: it must be the user's, unused, and less than an hour old. Otherwise the answer is `404 not_found`, meaning "paste the link again".
3. If a cut-out was sent, checks and stores it first, so a rejected cut-out (`bad_request` on `cutout`) leaves the import usable for another try.
4. Claims the import in one database statement. **Each import can be tagged only once**, so replaying step 2 can't run Gemini again; if the claim fails, any stored cut-out is removed.
5. Counts the item against the daily cap.
6. Tags the original (or the cut-out), using the product title, brand and colour **it stored in step 1** as hints. It never uses data the phone sends back.
7. Returns `{ draft }`, exactly as add-by-photo does, or for a batch add `{ status: "saved", item }` / `{ status: "draft", draft }`. *Stub outside mock mode for the batch add.*

**Several links at once (M5).** The phone splits the pasted text into links and runs both steps for each, one after another, with `saveForReview: true`. Links that need the screenshot fallback are listed at the end.

An import that's never finished leaves an unused image in storage. Two cleanup jobs handle this: `cleanUpOrphanedImages` (src/lib/ingestion/cleanup.ts) deletes images over 24 hours old that no item or open import uses, and `cleanUpOldLinkImports` (src/lib/link-import/cleanup.ts) deletes `link_imports` rows over 7 days old. Both run daily from `GET /api/cron/cleanup` (see "Scheduled jobs" below).

Android can "share" a product page straight to the installed app; it opens `/add/link?url=…` (a wardrobe-ui page). iPhone doesn't support this, so users paste the link.

### Outfits (built; owner: outfit-engine)
| Route | Send | Get back |
| --- | --- | --- |
| `POST /api/outfits` | The outfit request (section 4), **(M5)** with `includeShopItems` | `{ status: "ok", outfits, missingCategories }` or `{ status: "incomplete_wardrobe", reason, missingCategories, message }` (section 4). |
| `GET /api/outfits?status=saved` | `status` optional | `{ outfits }`, newest first |
| `GET /api/outfits/:id` | | `{ outfit }` |
| `PATCH /api/outfits/:id` | `{ status: "saved" }`, `"liked"`, `"suggested"`, or `{ status: "rejected", reason? }` | `{ outfit }`. Rejecting also records feedback. |
| `POST /api/outfits/:id/refine` | `{ kind: "swap", itemId }` or `{ kind: "guidance", text }` | Same as `POST /api/outfits`. The new outfits carry `parentOutfitId` and the parent's `includeShopItems`. |
| `POST /api/outfits/:id/shop-search` | **(M5)** Nothing. "Find in my shops". *Stub (outfit-engine).* | `{ outfit }` with each gap's `shopResults` filled |
| `PUT /api/outfits/:id/gaps/:category` | **(M5)** `{ productUrl }` (one of that gap's `shopResults`), or `{ productUrl: null }` to clear. *Stub (outfit-engine).* | `{ outfit }` with the gap's `shopProduct` set |

An **Outfit** is `{ id, request, name, reason, itemIds, items (full WardrobeItems, same order), gaps, status, parentOutfitId, createdAt }`. The collage uses `items`, and **(M5)** draws each gap in its slot as a dashed placeholder with its description, or the chosen product's image. `gaps` is empty for a complete outfit (and for every outfit saved before milestone 5).

**Find in my shops (M5).** Runs only when the user taps it, on an outfit with gaps (`bad_request` otherwise):
1. Checks the daily shop search cap (**10 a day**, cap kind `shop_searches_per_day`) and the AI pause, and counts one search for the whole outfit, whatever its number of gaps.
2. Makes **one** Gemini call with Google Search grounding for all the gaps, limited to the user's favourite shops' domains. The reply is checked (section 6).
3. Keeps only links on a favourite shop's website (`shopForUrl`), then fetches each through the add-by-link fetcher, with its safety checks, to confirm the page exists and read its title, price and image. Pages that don't load or aren't products are dropped.
4. Stores up to **3 products per gap** on the outfit (`shopResults`, `searchedAt`), replacing earlier results. A chosen product is kept. Nothing else is stored, and nothing is bought in the app.

**Choosing a product.** `PUT /api/outfits/:id/gaps/:category` copies the product from the gap's stored results, so the phone can't plant a link of its own. `not_found` if the outfit has no gap in that slot; `bad_request` if the URL isn't one of its results. "Open in shop" uses the product's `url`. Once bought, "Add to wardrobe" sends that `url` through add-by-link.

### Settings (M5; stub, built by link-import)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/settings` | | `{ favouriteShopIds, forwardingAddress }` |
| `PUT /api/settings` | `{ favouriteShopIds }`: 1 or more IDs from the list in section 4, no duplicates | The settings |
| `POST /api/settings/forwarding-address` | Nothing. Resets the address: a new random token, and the old address stops working at once. | The settings |

`forwardingAddress` is `<prefix><token>@<domain>`, built from `INBOUND_EMAIL_PREFIX` and `INBOUND_EMAIL_DOMAIN` (section 9). It's **null when `INBOUND_EMAIL_DOMAIN` isn't set**, and the UI then says email import isn't set up yet.

### Order emails (M5; stub, built by link-import)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/email-imports` | | `{ imports }`: the 20 most recent forwarded emails, newest first, each `{ id, receivedAt, shopName, orderDate, status, itemCount, skippedCount, error }` |
| `POST /api/inbound/email` | The inbound email service's webhook (below). **Not a signed-in route.** | `{ received: true }` |

**How the webhook authenticates.** It has no session: the email service calls it, not a browser. Its only authentication is the service's own signature (an HMAC over the raw body, with a timestamp so old requests can't be replayed) or credentials (e.g. HTTP Basic in the webhook URL, for Postmark), checked against `INBOUND_EMAIL_WEBHOOK_SECRET` in constant time **before anything is parsed**. A bad or missing signature is `401 unauthorized`; a missing or short secret is `500 server_misconfigured`, so it refuses everything rather than accepting unsigned posts. It's safe outside the CSRF and session checks because nothing it does acts on a browser session: the proxy skips session handling for `/api/inbound/` (like the cron route), and the cross-site check passes server-to-server posts (they send no `Origin`). Which service is used is `INBOUND_EMAIL_PROVIDER`; each has an adapter behind `InboundEmailProvider` in `src/lib/email/types.ts`.

**What it does with an email:**
1. Refuses bodies over 2 MB. Verifies the signature, then has the adapter turn the service's format into the **normalised email**: `{ messageId, from, to[], subject, text, html, receivedAt, auth: { spf, dkim, dmarc }, spam: { isSpam, score } }`. Attachments are never included. Text is cut to 100,000 characters and HTML to 500,000.
2. Finds the user from the token in a recipient address. Unknown token: answers `{ received: true }` and records nothing, so the address can't be probed.
3. Skips a redelivered email (same message ID hash for that user).
4. **Accepts it only if** it was forwarded from the user's own sign-in address, the service doesn't mark it as spam, and it passes authentication: DMARC passes, or (where the sender's domain has no DMARC policy) both SPF and DKIM pass. The shared `judgeInboundEmail(email, userEmail)` holds this rule. A refused email is recorded as `failed` with `sender_not_allowed` or `failed_checks`, and nothing else happens.
5. Counts one forwarded email (**10 a day**, cap kind `emails_per_day`), then has the model read the line items (section 6). Only the email's text goes to the model (HTML is converted to text, keeping product and image links).
6. For each clothing or shoe line: fetches the image (the email's image link, else the product page through the add-by-link route), stores it, tags it, counts an item against the daily item cap, and saves it with source `email` and "to review". A line without a usable picture is saved with a placeholder picture and `needsPhoto`. When the item cap runs out, the rest are counted in `skippedCount` with `daily_cap_reached`.
7. Updates the `email_imports` row (shop name, order date, counts, status) and drops the email. Nothing of it is logged.

It always answers `{ received: true }` once the signature checks out, so the service doesn't resend; only an error on our side (5xx) makes it retry.

### Usage and account (built)
| Route | Get back |
| --- | --- |
| `GET /api/usage` | `{ itemsToday: { used, limit }, outfitRequestsToday: { used, limit }, emailsToday: { used, limit }, shopSearchesToday: { used, limit }, dailyResetAt, aiPaused }` (**(M5)** the two new counters) |
| `DELETE /api/account` | `{ deleted: true }`. Deletes the user's images, then their account, which removes all their rows (settings and email imports included), then signs them out. |

### Scheduled jobs (built)
| Route | Send | Get back |
| --- | --- | --- |
| `GET /api/cron/cleanup` | `Authorization: Bearer <CRON_SECRET>` | `{ imagesChecked, orphanedImagesDeleted, linkImportsDeleted, signInAttemptsDeleted }` (counts only) |

Vercel Cron calls it once a day at 03:17 UTC (`vercel.json`). **Vercel runs cron jobs on production deployments only**, never on previews, so until the app has a production deployment the cleanup doesn't run on its own (it can be called by hand with the secret). It deletes images over a day old that no item or open link import uses, `link_imports` rows over 7 days old, and `sign_in_attempts` rows over a day old. The secret is compared in constant time. A wrong or missing header gets `401 unauthorized`. If `CRON_SECRET` isn't set, is blank, or has spaces or a newline around it (which no header could ever match), the answer is `500 server_misconfigured` and nothing runs. No user is involved, so it isn't behind sign-in. Neither the response nor the logs include keys, emails or other user data.

---

## 6. What the AI must return

The model's output is never trusted. Each reply is checked against a schema. If it fails, the call is retried once. If it fails again, the spec's fallback applies: empty tags for tagging, `ai_failed` for ranking, shop search and reading an email (a failed email is recorded with `ai_failed`). The shared helper `callWithValidation` does this. Extra fields the model adds are dropped; anything missing, mistyped or outside the vocabularies is rejected.

- **Tagging:** exactly the item tags from section 3.
- **Ranking pass 1 (tags only):** `{ outfits: [{ itemIds, gaps? }] }`, 1 to 10 outfits.
- **Ranking pass 2 (with ~256 px thumbnails):** `{ outfits: [{ itemIds, gaps?, name, reason }] }`, 1 to 5. The name is up to 40 characters and the reason up to 160.
- **(M5) Gaps in both passes:** `gaps` is optional (missing means none, so replies from before gaps still parse). Each gap is `{ category, subcategory?, colours, description }` in the item vocabularies: colours from the fixed palette, a subcategory that belongs to the category, a one-line description of up to 120 characters. At most 3, never two in one slot. `itemIds` may now hold a single item (a dress, say, with a shoes gap).
- After parsing, `checkRankedOutfits` throws out any outfit that uses an item ID the model wasn't given, (when the request has an anchor item) leaves the anchor out, breaks the composition rule counting owned items and gaps together, has no owned item, or **(M5)** has a gap that isn't allowed (section 4, "Gaps"). The engine passes it the gap rules: which categories its (filtered) wardrobe has, and `includeShopItems`; the anchor's category comes from the anchor item. Without gap rules, any gap is refused.
- **(M5) Shop search (Gemini with Google Search grounding):** `{ gaps: [{ category, candidates: [{ url, title }] }] }`, one entry per gap. A candidate whose link isn't a valid http(s) URL is dropped rather than failing the reply, and at most 8 per gap are kept. Nothing here is shown as it is: the server keeps only links on the user's favourite shops and fetches each page to confirm it and read the real title, price and image.
- **(M5) Order email:** `{ shopName, orderDate, items: [{ name, brand, colour, size, productUrl, imageUrl }] }`. Only clothes and shoes should be listed. `items` may be empty. Free text is flattened to one line and length-limited (name 200, brand 80, colour 60, size 30, shop name 80 characters). An unreadable date or an invalid link reads as empty rather than failing the reply; a line without a name fails it. At most 20 lines are used. The colour is as the email says it ("Khaki"); tagging maps it to the palette.

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

The tests include recorded bad replies: an invented "accessory" category, a colour like "dusty heather", formality as a word, a multi-line description, truncated JSON, prose instead of JSON, made-up item IDs and a missing anchor. **(M5)** And for the new outputs: gaps with an off-palette colour, an invented category, no description, a two-line description, a subcategory from another category, or two gaps in one slot; shop search replies as prose, with an unknown gap, duplicate gaps or bad links; order emails with a nameless line, truncated JSON or a missing item list (`src/contracts/milestone5.test.ts`).

---

## 7. Cost controls

| Setting | Value | Where |
| --- | --- | --- |
| New items per user per day | **40** [Decision] | `src/lib/usage/config.ts` |
| Outfit requests (including refinements) per user per day | **25** [Decision] | same |
| Add-by-link page fetches (step 1, fallbacks included) per user per day | **80** [Decision] | same |
| **(M5)** Forwarded order emails accepted per user per day | **10** [Decision] | same |
| **(M5)** "Find in my shops" searches per user per day | **10** [Decision] | same |
| AI spend cap, all users together, per calendar month | **£5** (Gemini only) | same |
| Estimated cost per Gemini call, when the real cost isn't known | tagging 0.2p, shortlist 0.2p, final pick 0.5p [Decision]; **(M5)** reading an email 0.5p, one grounded shop search **3p** [Decision] | same |
| Day and month boundaries | UK time (handles British Summer Time) | same |

Before starting work, every route that uses AI asks the usage guard whether it's allowed (`assertCanStart`, a quick check that counts nothing). The item cap is counted where tagging runs: in add-by-photo, in add-by-link step 2, and **(M5)** for each line of an order email (an email counts once against the email cap and once per item against the item cap). Step 1 only checks it, and counts a link fetch instead. **(M5)** A shop search counts once per outfit searched, not per gap. Saving a cut-out or adding a photo later uses no AI and counts nothing.

**(M5) The shop search estimate is a guess until measured.** Google charges for Search grounding per search query on top of tokens (roughly 1p to 3p a query at list prices, and one call can make several queries), and it's the most expensive call by far. 3p a search means the £5 month covers about 160 searches if nothing else ran. It runs only when the user taps "Find in my shops", has its own daily cap, and its estimate should be replaced with the measured cost in the first tester week. Grounding has a small free allowance on the paid tier. Once the month's total reaches £5, AI features pause (`ai_paused`) until the 1st, but browsing the wardrobe and saved outfits still works. Real per-call costs should replace the estimates after the first tester week.

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
| **(M5)** `ShopSearchProvider.searchGaps({ gaps, shops })` | `src/lib/ai/types.ts` | outfit-engine (Gemini with Google Search) |
| **(M5)** `OrderEmailProvider.extractOrder({ subject, text })` | `src/lib/ai/types.ts` | link-import (Gemini) |
| **(M5)** `InboundEmailProvider.verify(request)` and `.parse(rawBody)` | `src/lib/email/types.ts` | link-import (one per email service) |
| `BackgroundRemover.removeBackground(Blob or ImageBitmap) → PNG Blob`, in the browser | `src/lib/images/types.ts` | ingestion |
| `ServerImageProcessor.inspect / stripMetadata / resize / hasTransparency / prepareForModel` | `src/lib/images/server.ts` | ingestion (link-import reuses it, plus `checkUploadedCutout`, `cleanImage` and `suggestTags` from `src/lib/ingestion`) |
| `UsageGuard` (caps and spend): `assertCanStart`, `reserveAction`, `meterAiCalls` | `src/lib/usage/` | built; others call it |
| `requireUser()` | `src/lib/auth/session.ts` | built; first line of every route |

Fakes for tests (no network): `FakeTaggingProvider`, `FakeRankingProvider`, `FakeBackgroundRemover`, and **(M5)** `FakeShopSearchProvider` and `FakeOrderEmailProvider`.

**(M5) Shared helpers in `src/contracts/`:** `checkComposition(owned, gaps)`, `checkRankedOutfits(..., { anchorItemId, gaps })`, `missingCategoriesForOutfits`, `shopForUrl`, `forwardingAddress` / `tokenFromAddress`, `judgeInboundEmail`, `collageImageUrl`. Server config: `getForwardingAddressConfig()` and `getInboundWebhookSecret()` in `src/lib/env.server.ts`.

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
| `INBOUND_EMAIL_DOMAIN` | **(M5)** The domain the inbound email service receives mail for. Forwarding addresses are `<prefix><token>@<this domain>`. Empty: the app shows no address ("email import isn't set up yet"). |
| `INBOUND_EMAIL_PREFIX` | **(M5)** Optional. Put before the token, for a service with one fixed mailbox and plus-addressing: Postmark's `<hash>@inbound.postmarkapp.com` needs `INBOUND_EMAIL_DOMAIN=inbound.postmarkapp.com` and `INBOUND_EMAIL_PREFIX=<hash>+`. With your own domain (e.g. Cloudflare Email Routing), leave it empty. |
| `INBOUND_EMAIL_PROVIDER` | **(M5)** Which inbound email service posts to the webhook, e.g. `postmark` |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | **(M5)** Server only. At least 32 random characters. What the webhook checks the service's signature or credentials against; without it the webhook refuses everything. Set it in Vercel and in the email service's webhook settings. |

There's no background-removal key: it runs in the browser.

**(M5) For order emails**, Cheryl also chooses and sets up an inbound email service and a domain (or the service's own address), points its webhook at `<site>/api/inbound/email` with the secret, and tells it to drop attachments. For shop search, Gemini's paid tier (Google Search grounding has only a small free allowance).

In the Supabase dashboard:
1. Run the migrations in `supabase/migrations/` in order (e.g. `supabase db push`, or paste each into the SQL editor). **(M5)** Migration 7 (`20261030000007_milestone5.sql`) is safe to run twice; apply it before deploying this round's code.
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
- **(M5) Shop product images** (`imageUrl`) live on the shops' own servers, which the policy doesn't allow, and a canvas collage can't be saved as an image once it has drawn a picture from another site without CORS. See decision 6 in section 11.

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
17. **AI costs settle at most 3x their estimate**, which bounds how far past £5 the month can go (section 7). The bound is on the spend the app *records*: if Google ever charged more than 3x the estimate for a call, the real bill would be higher than the app's total (the clamp logs a warning when it fires). Today a tagging call is about 0.1p against a 0.6p clamp. The Google Cloud request quota (setup section) is the hard stop on the real bill.

---

## 11. Decisions for Cheryl (milestone 5)

Made while turning her test notes into contracts. The orchestrator's own decisions (shop search only on request, at most one shop item per outfit, the email acceptance rule, batch items saved as "to review") are in `docs/PROGRESS.md`.

1. **Two new daily caps: 10 forwarded emails and 10 shop searches per person.** An email's items also count against the 40 items a day. A shop search counts once per outfit, however many gaps it has.
2. **Cost estimates: 0.5p to read an email, 3p for one shop search.** The shop search figure is a guess until measured: Google charges for Search grounding per query, on top of tokens, and one call can make several queries. At 3p, the £5 month would cover about 160 searches with nothing else running. To be replaced with the measured cost in the first tester week.
3. **The shop list**: Next, M&S, New Look (the defaults), John Lewis, River Island, Zara, H&M, Uniqlo, ASOS, Mango, Matalan and FatFace. Primark is left out because it has no UK online shop. The website domains come from knowledge and weren't checked live (this environment can't reach the shops). Adding a shop later is a small contract change plus a migration.
4. **Cut-outs at collage time.** The add flow no longer sends a cut-out. The old optional cut-out field still works until the new add screens ship, then it's removed. When a collage cuts an item out, the cut-out is saved on the item for next time.
5. **A picture added later keeps the tags.** For an email item that came without a picture, adding a photo replaces the placeholder and puts the item back in "to review", but doesn't re-run tagging (no AI cost). Re-tagging from the photo is an easy change if you'd rather.
6. **Shop product pictures come from the shops' servers. Needs a choice before the outfit screens ship.** Two problems: the Content Security Policy (Report-Only today) doesn't allow other sites' images, and a collage that draws a picture from another site can't be saved as an image. Options: (a) the server fetches the product picture through the add-by-link fetcher and serves it from our own site (cleanest; a little more code); (b) show shop pictures only on the product cards, and draw the gap in the collage as the dashed placeholder with the product name; (c) allow each shop's image servers in the policy (a long, changing list, and saving the collage still breaks). Recommendation: (b) now, (a) if testers want the picture in the collage. **Orchestrator decided (b) for round 1.**
7. **Who can forward.** Only emails forwarded from your sign-in address are accepted. If you sign in with one address but get shop emails at another, forward them to your sign-in address first (or we could allow a second address later).
8. **Refused emails are listed**, without any of their content: if someone else sends to your forwarding address, or an email fails the checks, the app shows "an email couldn't be added" with the reason. Emails to an unknown address leave no trace.
9. **Settings live in their own table** (`user_settings`), not on `users`, so the rule "users can change only their display name" stays simple and the forwarding token can't be set by the user, only reset.
10. **A batch-added photo whose tagging fails** isn't saved (an item needs tags); it shows in the review list as a draft to fill in.
11. **An email line without a usable picture** is saved with a plain placeholder picture (so every item still has an original) and flagged to add a photo.
12. **An empty wardrobe** gets its own answer (`empty_wardrobe`) instead of a list of missing categories, so the outfit screen can point to the get-started checklist.
13. **Text-only tagging** (orchestrator, 2026-10-30): `TaggingInput.image` may be null for an order-email line with no usable picture; the model then tags from the product hints (title required). The ingestion agent makes the prompt handle it.
