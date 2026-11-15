// @vitest-environment jsdom
// QA (round 2, P3): the outfit picture panel and the "Pick your model"
// sheet as components. The collage itself is stubbed (it draws on a
// canvas, which jsdom lacks); what's tested is which of picture and
// collage shows, the notes, the labels, Save image and the sheet's saving.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_PRESET_ID,
  NO_PREVIEW,
  type Outfit,
  type OutfitPreview,
} from "@/contracts";
import { IDLE_ACTIVITY } from "./preview-view";

vi.mock("./outfit-collage", () => ({
  OutfitCollage: (props: { hideSave?: boolean; name: string }) => (
    <div data-testid="outfit-collage" data-hide-save={String(!!props.hideSave)}>
      {!props.hideSave && (
        <button type="button">Save image of {props.name}</button>
      )}
    </div>
  ),
}));

vi.mock("./collage-draw", async (original) => {
  const actual = await original<typeof import("./collage-draw")>();
  return {
    ...actual,
    loadImage: vi.fn(),
    canvasToPng: vi.fn(),
    saveImageBlob: vi.fn(),
  };
});

vi.mock("./api", async (original) => {
  const actual = await original<typeof import("./api")>();
  return {
    ...actual,
    outfitsApi: { ...actual.outfitsApi, saveModelPreset: vi.fn() },
  };
});

const draw = await import("./collage-draw");
const { outfitsApi } = await import("./api");
const { OutfitPreviewPanel } = await import("./outfit-preview");
const { PickModelSheet } = await import("./pick-model-sheet");

const PRESET = "women_average_medium" as const;
const URL_A =
  "https://x.supabase.co/storage/v1/object/sign/previews/a.webp?token=1";
const URL_B =
  "https://x.supabase.co/storage/v1/object/sign/previews/a.webp?token=2";
const READY: OutfitPreview = {
  ...NO_PREVIEW,
  status: "ready",
  imageUrl: URL_A,
  presetId: PRESET,
};

function outfit(preview: OutfitPreview, extra: Partial<Outfit> = {}): Outfit {
  return {
    id: "2b000000-0000-4000-8000-000000000001",
    request: {
      style: { kind: "preset", presetId: "casual" },
      guidance: null,
      anchorItemId: null,
      includeShopItems: false,
    },
    name: "Weekend layers",
    reason: "Because",
    itemIds: [],
    items: [],
    gaps: [],
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    preview,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(outfitsApi.saveModelPreset).mockReset();
  vi.mocked(draw.loadImage).mockResolvedValue({
    naturalWidth: 2,
    naturalHeight: 3,
  } as HTMLImageElement);
  vi.mocked(draw.canvasToPng).mockResolvedValue(
    new Blob(["png"], { type: "image/png" }),
  );
  vi.mocked(draw.saveImageBlob).mockResolvedValue("downloaded");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => {},
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("OutfitPreviewPanel", () => {
  it("a picture URL that 404s or has expired falls back to the collage, with Reload picture; a fresh URL shows the picture again", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <OutfitPreviewPanel
        outfit={outfit(READY)}
        activity={IDLE_ACTIVITY}
        onReloadPictures={reload}
      />,
    );
    const img = screen.getByTestId("preview-image");
    expect(screen.queryByTestId("outfit-collage")).toBeNull();
    fireEvent.error(img);

    expect(screen.queryByTestId("preview-image")).toBeNull();
    const collage = screen.getByTestId("outfit-collage");
    // The collage's own Save image is back, since there's no picture to save.
    expect(collage).toHaveAttribute("data-hide-save", "false");
    expect(screen.getByTestId("preview-note")).toHaveTextContent(
      "Couldn't load the picture",
    );
    expect(
      screen.queryByRole("button", { name: /Show the pieces/ }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Reload picture" }),
    );
    expect(reload).toHaveBeenCalledTimes(1);

    // The same URL stays broken; a freshly signed one gets a fresh try.
    rerender(
      <OutfitPreviewPanel
        outfit={outfit(READY)}
        activity={IDLE_ACTIVITY}
        onReloadPictures={reload}
      />,
    );
    expect(screen.queryByTestId("preview-image")).toBeNull();
    rerender(
      <OutfitPreviewPanel
        outfit={outfit({ ...READY, imageUrl: URL_B })}
        activity={IDLE_ACTIVITY}
        onReloadPictures={reload}
      />,
    );
    expect(screen.getByTestId("preview-image")).toHaveAttribute("src", URL_B);
    expect(screen.queryByTestId("preview-note")).toBeNull();
  });

  it("Save image saves the ready picture (PNG) under the outfit's name, with non-ASCII and long names intact", async () => {
    const name = "Été à Paris — 週末のコーデ ".repeat(8).trim();
    render(
      <OutfitPreviewPanel
        outfit={outfit(READY, { name })}
        activity={IDLE_ACTIVITY}
      />,
    );
    const save = screen.getByRole("button", { name: `Save image of ${name}` });
    // Only the picture's Save image; the collage's is hidden.
    expect(
      screen.getAllByRole("button", { name: /^Save image of / }),
    ).toHaveLength(1);
    await userEvent.click(save);
    await waitFor(() => expect(draw.saveImageBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(draw.saveImageBlob).mock.calls[0]![1]).toBe(name);
    expect(
      vi.mocked(draw.loadImage).mock.calls.every(([u]) => u === URL_A),
    ).toBe(true);
    expect(
      await screen.findByText("Image saved to your downloads."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("preview-image")).toHaveAttribute(
      "alt",
      `${name}, worn by your model`,
    );
  });

  it("a picture that can't be exported says so instead of failing silently", async () => {
    vi.mocked(draw.canvasToPng).mockRejectedValue(new Error("tainted"));
    render(
      <OutfitPreviewPanel outfit={outfit(READY)} activity={IDLE_ACTIVITY} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Save image of / }),
    );
    expect(
      await screen.findByText(/Couldn't save this image/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Save image of / }),
    ).toBeEnabled();
  });

  it("with the collage as fallback, the collage's own Save image is offered", () => {
    const failed: OutfitPreview = {
      ...NO_PREVIEW,
      status: "failed",
      failureReason: "ai_failed",
      presetId: PRESET,
    };
    render(
      <OutfitPreviewPanel outfit={outfit(failed)} activity={IDLE_ACTIVITY} />,
    );
    expect(screen.getByTestId("outfit-collage")).toHaveAttribute(
      "data-hide-save",
      "false",
    );
    expect(screen.getByTestId("outfit-preview")).toHaveAttribute(
      "data-reason",
      "failed",
    );
  });

  it("an outdated picture offers Update preview; while refreshing it keeps the old picture with Updating… and no button", async () => {
    const onUpdate = vi.fn();
    const outdated = { ...READY, outdated: true };
    const { rerender } = render(
      <OutfitPreviewPanel
        outfit={outfit(outdated)}
        activity={IDLE_ACTIVITY}
        onUpdatePreview={onUpdate}
      />,
    );
    expect(screen.getByText(/changed a suggested piece/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Update preview" }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);

    rerender(
      <OutfitPreviewPanel
        outfit={outfit({ ...outdated, refreshing: true })}
        activity={IDLE_ACTIVITY}
        onUpdatePreview={onUpdate}
      />,
    );
    expect(screen.getByTestId("preview-updating")).toHaveTextContent(
      "Updating…",
    );
    expect(screen.getByTestId("preview-image")).toHaveAttribute("src", URL_A);
    expect(screen.queryByRole("button", { name: "Update preview" })).toBeNull();
  });

  it("labels each suggested slot on the picture and in its alt text, and hides them with the collage", () => {
    const withGap = outfit(
      { ...READY, suggestedSlots: ["shoes", "outerwear"] },
      {
        gaps: [
          {
            category: "shoes",
            subcategory: "trainers",
            colours: ["white"],
            description: "White trainers",
          } as never,
        ],
      },
    );
    render(<OutfitPreviewPanel outfit={withGap} activity={IDLE_ACTIVITY} />);
    const list = screen.getByRole("list", {
      name: "Suggested pieces, not from your wardrobe",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Trainers suggested");
    expect(screen.getByTestId("preview-image").getAttribute("alt")).toMatch(
      /\(trainers suggested, .+ suggested\)$/,
    );
    // A failed picture shows no labels: the collage has its own dashed gaps.
    cleanup();
    render(
      <OutfitPreviewPanel
        outfit={{
          ...withGap,
          preview: {
            ...NO_PREVIEW,
            status: "failed",
            failureReason: "blocked",
            presetId: PRESET,
          },
        }}
        activity={IDLE_ACTIVITY}
      />,
    );
    expect(screen.queryByTestId("suggested-labels")).toBeNull();
  });

  it("shows the making notice while asked for, and the model prompt while waiting for a pick", () => {
    const { rerender } = render(
      <OutfitPreviewPanel
        outfit={outfit(NO_PREVIEW)}
        activity={{ ...IDLE_ACTIVITY, inProgress: true }}
      />,
    );
    expect(screen.getByTestId("preview-making")).toHaveTextContent(
      "Dressing your model…",
    );
    expect(screen.getByTestId("outfit-collage")).toBeInTheDocument();
    rerender(
      <OutfitPreviewPanel
        outfit={outfit(NO_PREVIEW)}
        activity={{ ...IDLE_ACTIVITY, awaitingPreset: true }}
      />,
    );
    expect(screen.getByTestId("preview-making")).toHaveTextContent(
      "Pick your model to see this outfit worn.",
    );
  });
});

describe("PickModelSheet", () => {
  it("opens with the default selected; closing saves the default once and starts the pictures", async () => {
    vi.mocked(outfitsApi.saveModelPreset).mockResolvedValue({
      ok: true,
      data: {
        modelPresetId: DEFAULT_MODEL_PRESET_ID,
        favouriteShopIds: [],
        forwardingAddress: null,
      },
    });
    const onSaved = vi.fn();
    render(<PickModelSheet open onSaved={onSaved} />);
    const sheet = screen.getByTestId("pick-model-sheet");
    expect(
      within(sheet).getByRole("radio", {
        name: "Women's, average build, medium skin tone",
      }),
    ).toBeChecked();
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(outfitsApi.saveModelPreset).toHaveBeenCalledTimes(1);
    expect(outfitsApi.saveModelPreset).toHaveBeenCalledWith(
      DEFAULT_MODEL_PRESET_ID,
    );
  });

  it("Escape also saves the default", async () => {
    vi.mocked(outfitsApi.saveModelPreset).mockResolvedValue({
      ok: true,
      data: {
        modelPresetId: DEFAULT_MODEL_PRESET_ID,
        favouriteShopIds: [],
        forwardingAddress: null,
      },
    });
    const onSaved = vi.fn();
    render(<PickModelSheet open onSaved={onSaved} />);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(outfitsApi.saveModelPreset).toHaveBeenCalledWith(
      DEFAULT_MODEL_PRESET_ID,
    );
  });

  it("a failed save keeps the sheet open with the error and the choice; trying again saves it", async () => {
    vi.mocked(outfitsApi.saveModelPreset)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "internal", message: "Down" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          modelPresetId: "women_plus_deep",
          favouriteShopIds: [],
          forwardingAddress: null,
        },
      });
    const onSaved = vi.fn();
    render(<PickModelSheet open onSaved={onSaved} />);
    const sheet = screen.getByTestId("pick-model-sheet");
    await userEvent.click(
      within(sheet).getByRole("radio", {
        name: "Women's, plus size build, deep skin tone",
      }),
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Use this model" }),
    );
    expect(await within(sheet).findByTestId("api-error")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId("pick-model-sheet")).toBeInTheDocument();
    expect(
      within(sheet).getByRole("radio", {
        name: "Women's, plus size build, deep skin tone",
      }),
    ).toBeChecked();

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Use this model" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(
      vi.mocked(outfitsApi.saveModelPreset).mock.calls.map(([id]) => id),
    ).toEqual(["women_plus_deep", "women_plus_deep"]);
  });

  it("a failed save on close keeps the sheet open too", async () => {
    vi.mocked(outfitsApi.saveModelPreset).mockResolvedValue({
      ok: false,
      error: { code: "internal", message: "Down" },
    });
    const onSaved = vi.fn();
    render(<PickModelSheet open onSaved={onSaved} />);
    await userEvent.click(
      within(screen.getByTestId("pick-model-sheet")).getByRole("button", {
        name: "Close",
      }),
    );
    expect(await screen.findByTestId("api-error")).toBeInTheDocument();
    expect(screen.getByTestId("pick-model-sheet")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("double-tapping Use this model while saving sends one save", async () => {
    let resolve!: (
      v: Awaited<ReturnType<typeof outfitsApi.saveModelPreset>>,
    ) => void;
    vi.mocked(outfitsApi.saveModelPreset).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    const onSaved = vi.fn();
    render(<PickModelSheet open onSaved={onSaved} />);
    const button = within(screen.getByTestId("pick-model-sheet")).getByRole(
      "button",
      { name: "Use this model" },
    );
    fireEvent.click(button);
    fireEvent.click(button);
    expect(outfitsApi.saveModelPreset).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({
        ok: true,
        data: {
          modelPresetId: PRESET,
          favouriteShopIds: [],
          forwardingAddress: null,
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
