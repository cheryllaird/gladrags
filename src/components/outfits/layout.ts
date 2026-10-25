import type { CSSProperties } from "react";

/**
 * Spacing for the app's bottom navigation, which wardrobe-ui owns. If the
 * nav sets `--bottom-nav-height` (e.g. on <body>), sticky actions sit just
 * above it and page content isn't hidden behind it. Without it, both
 * default to the bottom of the screen.
 */
const NAV = "var(--bottom-nav-height, 0px)";
const SAFE_AREA = "env(safe-area-inset-bottom, 0px)";

/** For a `sticky` action bar at the bottom of a screen. */
export const STICKY_ACTION_STYLE: CSSProperties = { bottom: `calc(${NAV} + ${SAFE_AREA})` };

/** For a screen's <main>: room below the content for the nav. */
export const PAGE_BOTTOM_PADDING_STYLE: CSSProperties = { paddingBottom: `calc(${NAV} + ${SAFE_AREA} + 1.5rem)` };
