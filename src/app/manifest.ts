import type { MetadataRoute } from "next";

/** Served at /manifest.webmanifest. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "GladRags",
    short_name: "GladRags",
    description: "Your wardrobe, tagged, with outfit ideas for wherever you're going.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#171717",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // "Share" a product page from the browser to GladRags (spec: Add by link).
    // Android passes the link in `url` or inside `text`. The page at
    // /add/link belongs to wardrobe-ui. (iOS doesn't support share targets.)
    share_target: {
      action: "/add/link",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
