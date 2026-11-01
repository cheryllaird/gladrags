import { describe, expect, it } from "vitest";
import { SafeFetchShopPageChecker, productFromPage } from "./shop-pages";

const page = (extra = "") => `<!doctype html><html><head>
<meta property="og:type" content="product">
<meta property="og:title" content="White Leather Trainers">
<meta property="og:image" content="https://xcdn.next.co.uk/images/trainers.jpg">
<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  name: "White Leather Trainers",
  image: ["http://insecure.example/t.jpg", "https://xcdn.next.co.uk/images/trainers.jpg"],
  offers: { price: "45.00", priceCurrency: "GBP" },
})}</script>${extra}</head><body></body></html>`;

describe("productFromPage", () => {
  it("reads the title, price and an https image from the page itself", () => {
    expect(productFromPage(page(), new URL("https://www.next.co.uk/style/st1/k1#x"), "next")).toEqual({
      shopId: "next",
      title: "White Leather Trainers",
      url: "https://www.next.co.uk/style/st1/k1",
      priceText: "£45",
      imageUrl: "https://xcdn.next.co.uk/images/trainers.jpg",
    });
  });

  it("drops a page that redirected off the shop's website, or onto another shop", () => {
    expect(productFromPage(page(), new URL("https://www.amazon.co.uk/dp/1"), "next")).toBeNull();
    expect(productFromPage(page(), new URL("https://www.zara.com/p1"), "next")).toBeNull();
    expect(productFromPage(page(), new URL("https://www.next.co.uk.evil.example/p1"), "next")).toBeNull();
  });

  it("drops a page that isn't a product or has no title", () => {
    expect(productFromPage("<html><head><title>Trainers | Next</title></head></html>", new URL("https://www.next.co.uk/shop/trainers"), "next")).toBeNull();
    expect(productFromPage('<meta property="og:type" content="product"><meta property="og:image" content="https://x.next.co.uk/a.jpg">', new URL("https://www.next.co.uk/p"), "next")).toBeNull();
  });

  it("keeps a product without a price or picture", () => {
    const html = '<meta property="og:type" content="product"><meta property="og:title" content="Jacket">';
    expect(productFromPage(html, new URL("https://www.marksandspencer.com/p/1"), "marks_and_spencer")).toMatchObject({ priceText: null, imageUrl: null });
  });
});

describe("SafeFetchShopPageChecker", () => {
  it("doesn't fetch at all once the time budget is gone", async () => {
    const network = { resolve: async () => Promise.reject(new Error("must not be called")) };
    const checker = new SafeFetchShopPageChecker(network);
    expect(await checker.check({ url: "https://www.next.co.uk/p", shopId: "next", title: "x" }, 0)).toBeNull();
  });

  it("gives null (not an error) when the page can't be fetched safely", async () => {
    const network = { resolve: async () => [{ address: "10.0.0.1", family: 4 as const }] }; // a private address
    const checker = new SafeFetchShopPageChecker(network);
    expect(await checker.check({ url: "https://www.next.co.uk/p", shopId: "next", title: "x" }, 5_000)).toBeNull();
  });
});
