import type { NextConfig } from "next";

/**
 * Content Security Policy, sent as Report-Only for now (CONTRACTS.md
 * section 9): browsers report what it would block in the console but
 * block nothing. Switch the header to Content-Security-Policy after
 * Cheryl's test, once real use shows no reports.
 *
 * - script-src: Next.js puts small inline scripts in every page, hence
 *   'unsafe-inline'. 'wasm-unsafe-eval' lets the background remover
 *   (onnxruntime-web) compile its WebAssembly; it doesn't allow eval().
 *   The dev server also needs 'unsafe-eval' (React refresh), never a build.
 * - style-src: the UI sets some inline style attributes (progress bars,
 *   chip colours), hence 'unsafe-inline'.
 * - img-src: signed image URLs come from Supabase Storage; blob: and data:
 *   are the phone's own previews and cut-outs.
 * - worker-src: the background remover and the service worker.
 */
function contentSecurityPolicy(): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https://*.supabase.co",
    "connect-src 'self' https://*.supabase.co",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Sent with every response. */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera is used for photo capture (through a file input); nothing
  // needs location or the microphone.
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(), microphone=()" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  // The dev-tools bubble sits bottom-left, on top of the bottom navigation's
  // Wardrobe tab, which blocks taps in dev (and in dev-server e2e runs).
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      // The service worker must never be cached by the browser's HTTP cache,
      // otherwise updates to it can take a long time to reach users.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      // The background-removal model and runtime (src/lib/images). Their URLs
      // carry a ?v= version, so browsers can keep them for good.
      {
        source: "/models/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/ort/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
