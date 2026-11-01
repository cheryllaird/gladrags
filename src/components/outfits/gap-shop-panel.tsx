"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckIcon, ExternalLinkIcon, SearchIcon, ShoppingBagIcon, XIcon } from "lucide-react";
import type { Outfit, OutfitGap, ShopProduct } from "@/contracts";
import { COLOUR_LABELS, COLOUR_SWATCHES } from "@/components/wardrobe/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { outfitsApi, type ApiFailure } from "./api";
import { GAP_SLOT_LABELS, addBoughtProductHref, shopName } from "./gap-copy";
import { ApiErrorNotice } from "./result-notices";

/**
 * One gap in the outfit's item list: a dashed swatch where a picture would
 * be, the suggested item, and the product the user picked for it (if any),
 * with links to the shop and "I've bought this".
 */
export function GapRow(props: { gap: OutfitGap; busy: boolean; onClear: () => void; canClear: boolean }) {
  const { gap } = props;
  const product = gap.shopProduct;
  return (
    <li className="space-y-2 px-3 py-2" data-testid="gap-row" data-category={gap.category}>
      <div className="flex items-center gap-3">
        <GapSwatch gap={gap} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{gap.description}</p>
          <p className="text-muted-foreground text-xs">{GAP_SLOT_LABELS[gap.category]}: not in your wardrobe</p>
        </div>
        <Badge variant="outline" className="border-dashed">
          Suggested
        </Badge>
      </div>
      {product && (
        <div className="bg-muted/50 space-y-1 rounded-md p-2" data-testid="chosen-product">
          <p className="text-xs">
            <span className="text-muted-foreground">Your pick: </span>
            <span className="font-medium">{product.title}</span>
            <span className="text-muted-foreground">
              {" "}
              · {shopName(product)}
              {product.priceText ? ` · ${product.priceText}` : ""}
            </span>
          </p>
          <div className="flex flex-wrap gap-x-1">
            <ShopLink product={product} />
            <Button asChild variant="ghost" size="sm" className="h-11">
              <Link href={addBoughtProductHref(product)}>
                <ShoppingBagIcon aria-hidden />
                I&apos;ve bought this
              </Link>
            </Button>
            {props.canClear && (
              <Button type="button" variant="ghost" size="sm" className="h-11" disabled={props.busy} onClick={props.onClear}>
                <XIcon aria-hidden />
                Clear pick
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** A dashed box with the gap's colours, the same size as an item thumbnail. */
function GapSwatch({ gap }: { gap: OutfitGap }) {
  const label = gap.colours.map((c) => COLOUR_LABELS[c]).join(", ");
  return (
    <span
      className="flex size-11 shrink-0 items-center justify-center gap-0.5 rounded-md border-2 border-dashed"
      role="img"
      aria-label={`Colours: ${label}`}
    >
      {gap.colours.map((colour) => (
        <span
          key={colour}
          className="size-2.5 rounded-full border border-neutral-300"
          style={{ backgroundColor: COLOUR_SWATCHES[colour] }}
        />
      ))}
    </span>
  );
}

/** "View in shop": the product page, in a new tab, telling the shop nothing about where it came from. */
function ShopLink({ product }: { product: ShopProduct }) {
  return (
    <Button asChild variant="ghost" size="sm" className="h-11">
      <a href={product.url} target="_blank" rel="noopener noreferrer">
        <ExternalLinkIcon aria-hidden />
        View in {shopName(product)}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </Button>
  );
}

interface ShopFinderProps {
  outfit: Outfit;
  /** The outfit as the server now has it, after a search or a pick. */
  onOutfitChange: (outfit: Outfit) => void;
  /** A pick or clear in flight, shared with the gap rows. */
  picking: boolean;
  onPick: (gap: OutfitGap, productUrl: string | null) => void;
  pickError: ApiFailure | null;
}

/**
 * "Find in my shops" for an outfit with gaps: one search for all its gaps
 * (it counts against its own daily cap, so it runs only on a tap), then up
 * to three products per gap. A product can be picked for its gap.
 */
export function ShopFinder(props: ShopFinderProps) {
  const { outfit } = props;
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const searched = outfit.gaps.some((g) => g.searchedAt !== null);

  async function search() {
    setSearching(true);
    setError(null);
    const result = await outfitsApi.findInShops(outfit.id);
    setSearching(false);
    if (result.ok) props.onOutfitChange(result.data.outfit);
    else setError(result.error);
  }

  return (
    <section className="space-y-3" aria-label={`Shop suggestions for ${outfit.name}`} data-testid="shop-finder">
      <Button type="button" variant="outline" className="w-full" disabled={searching} onClick={() => void search()}>
        <SearchIcon aria-hidden />
        {searching ? "Searching your shops…" : searched ? "Search my shops again" : "Find in my shops"}
      </Button>
      <p role="status" aria-live="polite" className="sr-only">
        {searching ? "Searching your shops…" : ""}
      </p>
      {error && <ApiErrorNotice error={error} context="shop_search" onRetry={() => void search()} />}
      {props.pickError && <ApiErrorNotice error={props.pickError} context="shop_search" />}

      {outfit.gaps
        .filter((gap) => gap.searchedAt !== null)
        .map((gap) => (
          <div key={gap.category} className="space-y-2" data-testid="shop-results" data-category={gap.category}>
            <h3 className="text-sm font-medium">For the {gap.description.toLowerCase()}</h3>
            {gap.shopResults.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing found in your shops for this one.{" "}
                <Link href="/settings" className="underline underline-offset-4">
                  Choose more shops
                </Link>
              </p>
            ) : (
              <ul className="space-y-2" aria-label={`Products for the ${gap.description.toLowerCase()}`}>
                {gap.shopResults.map((product) => (
                  <ProductCard
                    key={product.url}
                    product={product}
                    chosen={gap.shopProduct?.url === product.url}
                    disabled={props.picking}
                    onToggle={(chosen) => props.onPick(gap, chosen ? product.url : null)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
    </section>
  );
}

function ProductCard(props: { product: ShopProduct; chosen: boolean; disabled: boolean; onToggle: (chosen: boolean) => void }) {
  const { product, chosen } = props;
  return (
    <li
      data-testid="product-card"
      data-chosen={chosen}
      className={cn("flex gap-3 rounded-lg border p-2", chosen && "border-primary ring-primary/30 ring-2")}
    >
      <ProductImage product={product} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="line-clamp-2 text-sm font-medium break-words">{product.title}</p>
        <p className="text-muted-foreground text-xs">
          {shopName(product)}
          {product.priceText ? ` · ${product.priceText}` : ""}
        </p>
        <div className="flex flex-wrap gap-x-1">
          <ShopLink product={product} />
          <Button
            type="button"
            variant={chosen ? "secondary" : "ghost"}
            size="sm"
            className="h-11"
            aria-pressed={chosen}
            disabled={props.disabled}
            onClick={() => props.onToggle(!chosen)}
          >
            {chosen ? <CheckIcon aria-hidden /> : null}
            {chosen ? "Picked" : "Pick this"}
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * The product's picture, straight from the shop's server (decision 6b:
 * on the card only, never on the collage). No referrer, so the shop
 * doesn't learn which page showed it. An icon if there's none, or it
 * doesn't load.
 */
function ProductImage({ product }: { product: ShopProduct }) {
  const [failed, setFailed] = useState(false);
  if (!product.imageUrl || failed) {
    return (
      <span className="bg-muted text-muted-foreground flex size-20 shrink-0 items-center justify-center rounded-md" aria-hidden>
        <ShoppingBagIcon className="size-6" />
      </span>
    );
  }
  return (
    // Shop images come from many hosts; next/image would need each one configured.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={product.imageUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="bg-muted size-20 shrink-0 rounded-md object-contain"
    />
  );
}
