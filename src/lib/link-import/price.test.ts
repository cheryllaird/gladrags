import { describe, expect, it } from "vitest";
import { formatPrice, parseAmount, parseProductPrice } from "./price";

const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe("parseProductPrice", () => {
  it("reads a schema.org Offer", () => {
    expect(parseProductPrice(ld({ "@type": "Product", name: "Tee", offers: { "@type": "Offer", price: "35.00", priceCurrency: "GBP" } }))).toBe("£35");
    expect(parseProductPrice(ld({ "@type": "Product", name: "Tee", offers: [{ price: 12.5, priceCurrency: "EUR" }] }))).toBe("€12.50");
  });

  it("reads an AggregateOffer range, a priceSpecification and a variant's offer", () => {
    expect(parseProductPrice(ld({ "@type": "Product", offers: { "@type": "AggregateOffer", lowPrice: "29.5", highPrice: "35", priceCurrency: "GBP" } }))).toBe("£29.50 - £35");
    expect(parseProductPrice(ld({ "@type": "Product", offers: { priceSpecification: { price: "40", priceCurrency: "GBP" } } }))).toBe("£40");
    expect(parseProductPrice(ld({ "@type": "ProductGroup", hasVariant: [{ "@type": "Product", offers: { price: "18", priceCurrency: "GBP" } }] }))).toBe("£18");
  });

  it("falls back to Open Graph product price tags", () => {
    expect(parseProductPrice('<meta property="product:price:amount" content="22.00"><meta property="product:price:currency" content="GBP">')).toBe("£22");
    expect(parseProductPrice('<meta property="og:price:amount" content="100">')).toBe("100");
  });

  it("ignores prices that aren't plain numbers, and pages without one", () => {
    expect(parseProductPrice(ld({ "@type": "Product", offers: { price: "free!", priceCurrency: "GBP" } }))).toBeNull();
    expect(parseProductPrice(ld({ "@type": "Product", offers: { price: -5 } }))).toBeNull();
    expect(parseProductPrice("<html><title>Nothing</title></html>")).toBeNull();
  });
});

describe("helpers", () => {
  it("parseAmount accepts plain numbers and thousands separators only", () => {
    expect(parseAmount("1,035.50")).toBe(1035.5);
    expect(parseAmount("35")).toBe(35);
    expect(parseAmount("£35")).toBeNull();
    expect(parseAmount("1e9")).toBeNull();
    expect(parseAmount(Number.NaN)).toBeNull();
  });

  it("formatPrice uses a symbol for GBP, EUR and USD, and the code otherwise", () => {
    expect(formatPrice(35, "GBP")).toBe("£35");
    expect(formatPrice(9.9, "USD")).toBe("$9.90");
    expect(formatPrice(300, "SEK")).toBe("300 SEK");
    expect(formatPrice(3, null)).toBe("3");
  });
});
