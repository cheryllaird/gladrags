import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dev-tools bubble sits bottom-left, on top of the bottom navigation's
  // Wardrobe tab, which blocks taps in dev (and in dev-server e2e runs).
  devIndicators: false,
  // The service worker must never be cached by the browser's HTTP cache,
  // otherwise updates to it can take a long time to reach users.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
