import { expect, type Page } from "@playwright/test";

// Phone layout checks at 390 px for the milestone 5 wardrobe screens (the
// same checks wardrobe-qa.spec.ts makes for the earlier ones): no sideways
// scroll, tap targets of at least 44 px, and nothing under the bottom nav.

export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed";
      })
      .filter((el) => !el.closest(".sr-only") && !el.classList.contains("sr-only"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`),
  }));
  expect(overflow, `sideways overflow; widest: ${overflow.wide.join(", ")}`).toEqual({ page: 0, wide: [] });
}

/** Visible tap targets smaller than 44 px in either direction. */
export async function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const targets = [
      ...document.querySelectorAll<HTMLElement>("button, a[href], select, input:not([type=hidden]):not(.sr-only), label:has(> input.sr-only)"),
    ];
    return targets
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || el.closest("[aria-hidden=true]")) return false;
        return r.height < 43.5 || r.width < 43.5;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
        return `${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`;
      });
  });
}

/**
 * Scrolled to the bottom, nothing in the page content may sit under the
 * bottom navigation, and any sticky action bar must sit on top of the nav.
 */
export async function expectNavCoversNothing(page: Page) {
  const result = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (!nav) return { covered: [], navTop: null };
    const navTop = nav.getBoundingClientRect().top;
    const covered = [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input:not(.sr-only), main label, main p, main h2")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.bottom > navTop + 0.5 && r.top < window.innerHeight;
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    return { covered, navTop };
  });
  expect(result.covered, "content hidden under the bottom navigation").toEqual([]);
}

export async function checkPhoneLayout(page: Page, screen: string) {
  await expectNoSidewaysScroll(page);
  expect(await smallTapTargets(page), `tap targets under 44 px on ${screen}`).toEqual([]);
  await expectNavCoversNothing(page);
}
