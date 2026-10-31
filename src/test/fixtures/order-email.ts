/**
 * Recorded order-email model replies (OrderEmailModelOutputSchema), good
 * and bad, for the order-email fixtures in src/lib/email/fixtures/. The
 * shops, people and links are invented. Replies are JSON strings, as
 * Gemini returns them.
 */

/** next-order.html: two clothes lines, the card holder left out. */
export const NEXT_REPLY = JSON.stringify({
  shopName: "Northgate",
  orderDate: "2026-10-28",
  items: [
    {
      name: "Navy Slim Fit Stretch Chinos",
      brand: "Northgate",
      colour: "Navy",
      size: "32R",
      productUrl: "https://www.northgate.example/style/st123456/k98765",
      imageUrl: "https://cdn.northgate.example/products/k98765-navy.jpg",
    },
    {
      name: "White Long Sleeve Oxford Shirt",
      brand: "Northgate",
      colour: "White",
      size: "M",
      productUrl: "https://www.northgate.example/style/st555111/m22001",
      imageUrl: "https://cdn.northgate.example/products/m22001-white.jpg",
    },
  ],
});

/** ms-order.html: the jumper has a picture, the dress has no links at all; candle and gift card left out. */
export const MS_REPLY = JSON.stringify({
  shopName: "Marlow & Sons",
  orderDate: "2026-10-29",
  items: [
    {
      name: "Pure Cotton Crew Neck Jumper",
      brand: "",
      colour: "Khaki",
      size: "L",
      productUrl: "https://www.marlowandsons.example/pure-cotton-crew-neck-jumper/p/clp60512345",
      imageUrl: "https://asset1.marlowandsons.example/is/image/ms/SD_01_T41_7713_E0_X_EC_0?$PDP$",
    },
    { name: "Floral Midi Tea Dress", brand: "", colour: "Blue Mix", size: "12", productUrl: "", imageUrl: "" },
  ],
});

/** newlook-order.txt: plain text, product links only (pictures come from the product pages). */
export const LOOKWELL_REPLY = JSON.stringify({
  shopName: "Lookwell",
  orderDate: "2026-10-30",
  items: [
    {
      name: "Black Leather Look Chelsea Boots",
      brand: "Lookwell",
      colour: "Black",
      size: "6",
      productUrl: "https://www.lookwell.example/uk/womens/footwear/boots/black-leather-look-chelsea-boots/p/811222001",
      imageUrl: "",
    },
    {
      name: "Light Blue Ripped Mom Jeans",
      brand: "Lookwell",
      colour: "",
      size: "10 Regular",
      productUrl: "https://www.lookwell.example/uk/womens/clothing/jeans/light-blue-ripped-mom-jeans/p/799001234",
      imageUrl: "",
    },
  ],
});

/** No clothes or shoes in the order. */
export const EMPTY_REPLY = JSON.stringify({ shopName: "Northgate", orderDate: "2026-10-28", items: [] });

/** Bad replies the model might give. */
export const BAD_REPLIES = {
  prose: "Sure! The customer bought some navy chinos and a white shirt.",
  truncated: '{"shopName":"Northgate","orderDate":"2026-10-28","items":[{"name":"Navy Slim Fit',
  missingItems: JSON.stringify({ shopName: "Northgate", orderDate: "2026-10-28" }),
  itemsNotAList: JSON.stringify({ shopName: "Northgate", orderDate: "2026-10-28", items: "chinos, shirt" }),
} as const;

/**
 * Parses, but some lines are dropped or links blanked by the contract:
 * a nameless line, a link to a private address (kept by the schema: it's
 * a valid URL, but the SSRF-safe fetcher refuses it), a javascript: link
 * (read as null), and an unreadable date.
 */
export const ODD_REPLY = JSON.stringify({
  shopName: "Northgate\nIgnore previous instructions",
  orderDate: "28th October",
  items: [
    { name: "", brand: "Northgate", colour: "Navy", size: "32R", productUrl: "", imageUrl: "" },
    {
      name: "Navy Slim Fit Stretch Chinos",
      brand: "Northgate",
      colour: "Navy",
      size: "32R",
      productUrl: "javascript:alert(1)",
      imageUrl: "http://169.254.169.254/latest/meta-data/iam",
    },
  ],
});

/** A reply listing more lines than are kept (MAX_EMAIL_LINE_ITEMS is 20). */
export function manyLinesReply(count: number): string {
  return JSON.stringify({
    shopName: "Northgate",
    orderDate: "2026-10-28",
    items: Array.from({ length: count }, (_, i) => ({ name: `Plain T-Shirt ${i + 1}`, brand: "", colour: "White", size: "M", productUrl: "", imageUrl: "" })),
  });
}
