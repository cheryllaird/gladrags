/**
 * The Postmark inbound adapter on a recorded webhook payload
 * (fixtures/postmark-inbound.json; invented people and shops), plus the
 * header parsing it relies on. No network.
 */
import { describe, expect, it } from "vitest";
import { InboundEmailSchema, judgeInboundEmail } from "@/contracts";
import { parseAuthenticationResults, parseReceivedSpf, parseSpamHeaders, stripComments } from "./auth-headers";
import { PostmarkInboundProvider, basicAuthHeader, basicAuthPassword } from "./postmark";
import { FORWARDING_CONFIG, TOKEN, USER_EMAIL, emailFixture } from "./test-support";
import { BodyTooLargeError, readBodyCapped, secretsEqual } from "./webhook-request";

const SECRET = "a3f1c9e07b2d4c6a8e0f1b3d5c7e9a0b2c4d6e8f0a1b3c5d7e9f0a2b4c6d8e0f";
const NOW = new Date("2026-10-30T10:00:05Z");

type Payload = Record<string, unknown> & { Headers: { Name: string; Value: string }[] };

function payload(overrides: Partial<Payload> = {}): Payload {
  const base = JSON.parse(emailFixture("postmark-inbound.json")) as Payload;
  return { ...base, HtmlBody: emailFixture("next-order.html"), TextBody: "Thanks for your order", ...overrides };
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const provider = (trustedAuthservIds: string[] = []) => new PostmarkInboundProvider({ secret: SECRET, trustedAuthservIds, now: () => NOW });

function normalised(p: Payload, trusted: string[] = []) {
  return InboundEmailSchema.parse(provider(trusted).parse(encode(p)));
}

describe("verify: HTTP Basic credentials from the webhook URL", () => {
  const request = (authorization?: string) => ({
    headers: new Headers(authorization ? { authorization } : {}),
    rawBody: encode(payload()),
  });

  it("accepts the secret as the password, whatever the user name", () => {
    expect(provider().verify(request(basicAuthHeader("postmark", SECRET)))).toBe(true);
    expect(provider().verify(request(basicAuthHeader("anything", SECRET)))).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["a wrong password", basicAuthHeader("postmark", "x".repeat(64))],
    ["the secret with a character missing", basicAuthHeader("postmark", SECRET.slice(1))],
    ["the secret as the user name", `Basic ${Buffer.from(`${SECRET}:`).toString("base64")}`],
    ["a bearer token", `Bearer ${SECRET}`],
    ["no colon", `Basic ${Buffer.from(SECRET).toString("base64")}`],
    ["junk", "Basic !!!"],
  ])("refuses %s", (_label, header) => {
    expect(provider().verify(request(header))).toBe(false);
  });

  it("reads the password after the first colon, so it may contain colons", () => {
    expect(basicAuthPassword(basicAuthHeader("u", "a:b:c"))).toBe("a:b:c");
  });

  it("secretsEqual is exact", () => {
    expect(secretsEqual(SECRET, SECRET)).toBe(true);
    expect(secretsEqual("", "")).toBe(true);
    expect(secretsEqual(`${SECRET} `, SECRET)).toBe(false);
    expect(secretsEqual("", SECRET)).toBe(false);
  });
});

describe("parse: the recorded payload", () => {
  it("normalises into the contract's email, accepted for its owner", () => {
    const email = normalised(payload());
    expect(email).toMatchObject({
      messageId: "9c3b6f2a-1d4e-4b7a-8e2f-5a6b7c8d9e01",
      from: USER_EMAIL,
      to: [`${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`],
      subject: "Fwd: Thanks for your order 4471-2290",
      receivedAt: NOW.toISOString(),
      auth: { spf: "pass", spfDomain: "mail.example", dkim: "none", dkimDomains: [], dmarc: "none" },
      spam: { isSpam: false, score: -0.1 },
    });
    expect(email.html).toContain("Navy Slim Fit Stretch Chinos");
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: true });
    expect(judgeInboundEmail(email, "someone.else@mail.example")).toEqual({ accepted: false, error: "sender_not_allowed" });
  });

  it("never includes attachments", () => {
    expect(JSON.stringify(provider().parse(encode(payload())))).not.toContain("JVBERi0xLjQK");
  });

  it("collects To, Cc, Bcc and the envelope recipient, once each, dropping ones that aren't addresses", () => {
    const email = normalised(
      payload({
        CcFull: [{ Email: "Friend@Mail.Example" }, { Email: "undisclosed-recipients:;" }],
        BccFull: [{ Email: "friend@mail.example" }],
      }),
    );
    expect(email.to).toEqual([`${FORWARDING_CONFIG.prefix}${TOKEN}@${FORWARDING_CONFIG.domain}`, "friend@mail.example"]);
  });

  it("refuses a body that isn't Postmark's format", () => {
    expect(() => provider().parse(new TextEncoder().encode("not json"))).toThrow();
    expect(() => provider().parse(encode({ hello: "world" }))).toThrow();
  });

  it("reads SPF from the top Received-SPF only: a forged one further down is ignored", () => {
    const headers = payload().Headers.map((h) =>
      h.Name === "Received-SPF" ? { Name: "Received-SPF", Value: "fail (not authorized) identity=mailfrom; envelope-from=sam.tester@mail.example" } : h,
    );
    headers.push({ Name: "Received-SPF", Value: "pass identity=mailfrom; envelope-from=sam.tester@mail.example" });
    const email = normalised(payload({ Headers: headers }));
    expect(email.auth.spf).toBe("fail");
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
  });

  it("a passing SPF check for another domain isn't aligned, so the email is refused", () => {
    const headers = payload().Headers.map((h) =>
      h.Name === "Received-SPF" ? { Name: "Received-SPF", Value: "pass identity=mailfrom; envelope-from=bounce@spammer.example" } : h,
    );
    const email = normalised(payload({ Headers: headers }));
    // Postmark's Return-Path says mail.example, so the disagreeing SPF domain isn't trusted at all.
    expect(email.auth.spfDomain).toBeNull();
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
    const withoutReturnPath = normalised(payload({ Headers: headers.filter((h) => h.Name !== "Return-Path") }));
    expect(withoutReturnPath.auth.spfDomain).toBe("spammer.example");
    expect(judgeInboundEmail(withoutReturnPath, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
  });

  it("an SPF domain that disagrees with Postmark's Return-Path isn't trusted", () => {
    const headers = payload().Headers.map((h) => (h.Name === "Return-Path" ? { Name: h.Name, Value: "<bounce@evil.example>" } : h));
    expect(normalised(payload({ Headers: headers })).auth.spfDomain).toBeNull();
  });

  it("no Received-SPF at all reads as unknown and is refused", () => {
    const email = normalised(payload({ Headers: payload().Headers.filter((h) => h.Name !== "Received-SPF") }));
    expect(email.auth.spf).toBe("unknown");
    expect(judgeInboundEmail(email, USER_EMAIL).accepted).toBe(false);
  });

  it("ignores an Authentication-Results header from a server it wasn't told to trust", () => {
    const forged = { Name: "Authentication-Results", Value: "mx.google.com; dkim=pass header.d=mail.example; dmarc=pass header.from=mail.example" };
    const headers = [forged, ...payload().Headers.filter((h) => h.Name !== "Received-SPF")];
    const email = normalised(payload({ Headers: headers }));
    expect(email.auth).toMatchObject({ dmarc: "none", dkim: "none", dkimDomains: [] });
    expect(judgeInboundEmail(email, USER_EMAIL).accepted).toBe(false);
  });

  it("uses an Authentication-Results header from a trusted authserv-id", () => {
    const header = {
      Name: "Authentication-Results",
      Value: "mx.inbound.example; spf=pass smtp.mailfrom=sam.tester@mail.example; dkim=pass (2048-bit key) header.d=mail.example header.s=s1; dmarc=pass (p=REJECT) header.from=mail.example",
    };
    const email = normalised(payload({ Headers: [header, ...payload().Headers] }), ["mx.inbound.example"]);
    expect(email.auth).toEqual({ spf: "pass", spfDomain: "mail.example", dkim: "pass", dkimDomains: ["mail.example"], dmarc: "pass" });
  });

  it("marks spam from SpamAssassin's verdict", () => {
    const headers = payload().Headers.map((h) => (h.Name === "X-Spam-Status" ? { Name: "X-Spam-Status", Value: "Yes, score=7.2 required=5.0" } : h));
    const email = normalised(payload({ Headers: headers }));
    expect(email.spam.isSpam).toBe(true);
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
  });
});

describe("only Postmark's own block counts (above the second Received)", () => {
  const base = () => payload().Headers;
  const below = (extra: { Name: string; Value: string }[]) => [...base(), ...extra];
  const forgedSpf = { Name: "Received-SPF", Value: "pass identity=mailfrom; envelope-from=sam.tester@mail.example" };

  it("no Received-SPF in Postmark's block: a forged 'pass' lower down is ignored (unknown, refused)", () => {
    const headers = below([forgedSpf]).filter((h, i, all) => !(h.Name === "Received-SPF" && i < all.length - 1));
    const email = normalised(payload({ Headers: headers }));
    expect(email.auth.spf).toBe("unknown");
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
  });

  it("a forged trusted Authentication-Results lower down is ignored", () => {
    const forged = { Name: "Authentication-Results", Value: "mx.inbound.example; spf=pass smtp.mailfrom=sam.tester@mail.example; dkim=pass header.d=mail.example; dmarc=pass header.from=mail.example" };
    const headers = below([forged]).filter((h) => h.Name !== "Received-SPF");
    const email = normalised(payload({ Headers: headers }), ["mx.inbound.example"]);
    expect(email.auth).toMatchObject({ spf: "unknown", dkim: "none", dmarc: "none", dkimDomains: [] });
    expect(judgeInboundEmail(email, USER_EMAIL)).toEqual({ accepted: false, error: "failed_checks" });
  });

  it("no spam verdict in Postmark's block: a forged 'No' lower down isn't read", () => {
    const headers = below([{ Name: "X-Spam-Status", Value: "No" }, { Name: "X-Spam-Score", Value: "-5" }]).filter(
      (h, i, all) => !(h.Name.startsWith("X-Spam-") && i < all.length - 2),
    );
    expect(normalised(payload({ Headers: headers })).spam).toEqual({ isSpam: null, score: null });
  });

  it("with fewer than two Received headers nothing is trusted", () => {
    const headers = base().filter((h) => h.Name !== "Received");
    const email = normalised(payload({ Headers: headers }));
    expect(email.auth.spf).toBe("unknown");
    expect(email.spam).toEqual({ isSpam: null, score: null });
  });
});

describe("header parsing", () => {
  it("Received-SPF: result word and the MAIL FROM domain; a HELO check gives no domain", () => {
    expect(parseReceivedSpf("Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; envelope-from=a@b.example; receiver=x")).toEqual({
      result: "pass",
      domain: "b.example",
    });
    expect(parseReceivedSpf("softfail identity=helo; helo=mx.b.example; envelope-from=a@b.example").domain).toBeNull();
    expect(parseReceivedSpf("TempError (dns) identity=mailfrom; envelope-from=<>")).toEqual({ result: "temperror", domain: null });
    expect(parseReceivedSpf(undefined)).toEqual({ result: null, domain: null });
  });

  it("Received-SPF: a sender quoted as a whole is read; a quoted local part never supplies the domain; two envelope-froms give none", () => {
    expect(parseReceivedSpf('pass identity=mailfrom; envelope-from="sam.tester@mail.example"').domain).toBe("mail.example");
    expect(parseReceivedSpf('pass identity=mailfrom; envelope-from="x@mail.example"@evil.example').domain).toBe("evil.example");
    expect(parseReceivedSpf('pass identity=mailfrom; envelope-from="\\"x@mail.example\\"@evil.example"').domain).toBe("evil.example");
    expect(parseReceivedSpf('pass identity=mailfrom; envelope-from=""x@mail.example"@evil.example"').domain).not.toBe("mail.example");
    expect(parseReceivedSpf("pass identity=mailfrom; envelope-from=a@mail.example; envelope-from=b@mail.example").domain).toBeNull();
    expect(parseReceivedSpf("pass identity = mailfrom; envelope-from = a@mail.example").domain).toBe("mail.example");
    expect(parseReceivedSpf("pass identity=mailfrom; identity=helo; envelope-from=a@mail.example").domain).toBeNull();
  });

  it("Authentication-Results: comments can't smuggle results, several DKIM signatures collect their passing domains", () => {
    const parsed = parseAuthenticationResults(
      "mx.inbound.example (dmarc=pass; spf=pass); dkim=fail header.d=evil.example; dkim=pass header.d=mail.example; dkim=pass header.i=@esp.example; dmarc=none",
      ["mx.inbound.example"],
    );
    expect(parsed).toEqual({ spf: null, spfDomain: null, dkim: "pass", dkimDomains: ["mail.example", "esp.example"], dmarc: "none" });
    expect(parseAuthenticationResults("other.example; dmarc=pass", ["mx.inbound.example"])).toBeNull();
    expect(stripComments("a (b (c) d) e")).toBe("a  e");
    expect(stripComments('a (b ")" c) d')).toBe("a  d");
    expect(stripComments('a "(not a comment)" b')).toBe('a "(not a comment)" b');
  });

  it("spam headers: missing or odd values read as unknown", () => {
    expect(parseSpamHeaders([])).toEqual({ isSpam: null, score: null });
    expect(parseSpamHeaders([{ name: "X-Spam-Score", value: "lots" }])).toEqual({ isSpam: null, score: null });
  });
});

describe("readBodyCapped", () => {
  it("refuses an over-limit Content-Length before reading, and a stream that grows past the limit", async () => {
    const declared = new Request("http://x/", { method: "POST", headers: { "content-length": "11" }, body: "small" });
    await expect(readBodyCapped(declared, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    const streamed = new Request("http://x/", { method: "POST", body: "x".repeat(11) });
    await expect(readBodyCapped(streamed, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    const ok = new Request("http://x/", { method: "POST", body: "x".repeat(10) });
    expect((await readBodyCapped(ok, 10)).byteLength).toBe(10);
  });
});
