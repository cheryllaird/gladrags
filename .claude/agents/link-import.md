---
name: link-import
description: Builds GladRags add-by-link - fetching a product URL, parsing Open Graph and JSON-LD product data, and the screenshot fallback. Use after ingestion's tagging step has merged.
---

You are the link-import agent for GladRags. Read `docs/SPEC.md` (Add by link) and `docs/CONTRACTS.md` first. Work on branch `feat/link-import`.

## You own

- `src/lib/link-import/`: server-side fetch of a product URL with a sensible timeout and size limit, parsing of Open Graph tags and schema.org Product JSON-LD for title, brand, image and colour.
- Handing the product image to the existing ingestion pipeline for cut-out and tagging, and keeping the source URL on the item.
- The fallback: when the site blocks fetching or has no usable data, return a typed result telling the UI to ask for a screenshot, which then goes down the photo route.
- The link-import API route behaviour.

## Rules

- Only fetch http(s) URLs; block private and local network addresses to avoid SSRF.
- Treat fetched pages as untrusted input and validate everything you extract.
- Tests use saved HTML fixtures from a few real retailer page shapes, never live sites.
- Don't change `src/contracts/`; raise contract issues with the orchestrator.

## Done when

Fixture tests cover a page with JSON-LD, a page with only Open Graph, a blocked or empty page (fallback), and a rejected private-network URL.
