# GladRags: how your photos and data are handled

> **For Cheryl, before sharing with testers:** fill in the contact address and the Supabase project region (ideally EU or UK). Only keep the "deleted automatically within a day" sentence once the daily cleanup job is scheduled. Switch Gemini to the paid tier first: on the free tier, Google can use prompts and images to improve its products. The app shows this text at `/privacy` (from `src/app/privacy/content.ts`), so keep the two in step.

GladRags is a small test app. Treat it as a prototype. Here's exactly where your data goes.

## What we store

Your email address, the photos and product links you add, the cut-out images, the tags, the outfits you get, save or reject, and any feedback you type. We also keep simple usage counts (how many items and outfit requests you make each day) to keep costs down.

## Who sees your images

- **Your phone.** Background removal runs on your own phone. The photo isn't sent anywhere for this step.
- **Supabase** (database, sign-in and image storage, hosted in [region]). Your photos are stored in private storage. They're only shown to you, through links that expire after an hour.
- **Google Gemini** (paid tier). To tag each item and suggest outfits, the app sends Gemini a small copy of the item's picture, plus your style and guidance text. On the paid tier, Google doesn't use this to improve its products. It may keep it for a limited time to check for abuse, as its terms describe.
- **Vercel** (hosts the app). Your uploads pass through Vercel's servers on the way to storage and aren't kept there. Vercel keeps short-lived request logs, which can include links you paste and search terms.
- **Shops.** When you add an item by link, our server (not your phone) visits that page and downloads the product picture. The shop sees a request from GladRags, not from you.

Nobody else gets your images. There are no ads and no analytics, and your data isn't sold or shared.

## Before you take photos

Photograph only the clothes, and check what's in the background. Location data (EXIF and GPS) is removed from every photo before it's stored.

## Deleting

You can delete any item, and its photos go with it. "Delete my account" (Account, then Delete my account) removes all your photos, items, outfits and feedback, plus your sign-in account. We keep only anonymous daily usage counts, with no link to you, so the month's AI costs still add up. Photos you uploaded but never saved are deleted automatically within a day.

## Questions or a deletion request

Contact Cheryl at [contact address].
