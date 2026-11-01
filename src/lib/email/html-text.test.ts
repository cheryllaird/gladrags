import { describe, expect, it } from "vitest";
import { emailTextForModel, htmlToText } from "./html-text";
import { emailFixture } from "./test-support";

describe("htmlToText", () => {
  it("keeps the product names with their product and image links, one block per line", () => {
    const text = htmlToText(emailFixture("next-order.html"));
    expect(text).toContain("[image: Navy Slim Fit Stretch Chinos https://cdn.northgate.example/products/k98765-navy.jpg]");
    expect(text).toContain("Navy Slim Fit Stretch Chinos [link: https://www.northgate.example/style/st123456/k98765]");
    expect(text).toContain("Colour: Navy");
    expect(text).toContain("£28.00");
    expect(text.split("\n").length).toBeGreaterThan(5);
  });

  it("drops scripts, styles, the head and comments, and non-http links", () => {
    const text = htmlToText(emailFixture("next-order.html"));
    expect(text).not.toContain("should never reach the model");
    expect(text).not.toContain("font-family");
    expect(text).not.toContain("tracking pixel");
    expect(text).not.toContain("mailto:");
    expect(text).not.toMatch(/doctype/i);
    expect(htmlToText('<a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AAAA">')).toBe("x");
  });

  it("decodes entities and flattens control and bidi characters", () => {
    expect(htmlToText("<p>Fig &amp; Cedar&nbsp;&pound;8‮</p>")).toBe("Fig & Cedar £8");
  });

  it("copes with broken HTML", () => {
    expect(htmlToText("<p>Shirt<td>£10<a href='https://shop.example/p'>see")).toBe("Shirt | £10see");
  });
});

describe("emailTextForModel", () => {
  it("prefers the HTML, falls back to the plain text, and cuts to the limit without splitting an emoji", () => {
    expect(emailTextForModel({ text: "plain", html: "<p>rich</p>" })).toBe("rich");
    expect(emailTextForModel({ text: emailFixture("newlook-order.txt"), html: null })).toContain(
      "https://www.lookwell.example/uk/womens/footwear/boots/black-leather-look-chelsea-boots/p/811222001",
    );
    expect(emailTextForModel({ text: null, html: null })).toBe("");
    expect(emailTextForModel({ text: "ab😀", html: null }, 3)).toBe("ab");
    expect(emailTextForModel({ text: "x".repeat(70_000), html: null })).toHaveLength(60_000);
  });
});
