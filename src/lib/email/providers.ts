/**
 * The inbound email service adapter chosen by INBOUND_EMAIL_PROVIDER.
 *
 * Adding a service (e.g. Cloudflare Email Routing, through a small Worker
 * that posts the email as JSON with an HMAC signature):
 * 1. Write an adapter implementing InboundEmailProvider (types.ts):
 *    `verify` checks the signature over the raw body and a timestamp for
 *    freshness, using secretsEqual (webhook-request.ts) to compare;
 *    `parse` maps its JSON onto the normalised email, reading auth results
 *    with the helpers in auth-headers.ts.
 * 2. Add its name to INBOUND_EMAIL_PROVIDERS (src/lib/env.server.ts) and a
 *    case below.
 * 3. Give it recorded fixture payloads and tests, like postmark.test.ts.
 */
import "server-only";
import { getInboundEmailProviderConfig, getInboundWebhookSecret } from "@/lib/env.server";
import { PostmarkInboundProvider } from "./postmark";
import type { InboundEmailProvider } from "./types";

/** Throws ConfigError (500 server_misconfigured) if the secret or provider isn't set up. */
export function getInboundEmailProvider(): InboundEmailProvider {
  const secret = getInboundWebhookSecret();
  const { provider, trustedAuthservIds } = getInboundEmailProviderConfig();
  switch (provider) {
    case "postmark":
      return new PostmarkInboundProvider({ secret, trustedAuthservIds });
  }
}
