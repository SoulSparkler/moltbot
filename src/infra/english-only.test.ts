import { describe, expect, it } from "vitest";
import { assertEnglishOnly, generateEnglishCaption } from "./english-only.js";

describe("assertEnglishOnly", () => {
  it("trims and returns English text", () => {
    expect(assertEnglishOnly("  A beautiful vintage vase.  ")).toBe("A beautiful vintage vase.");
  });

  it("blocks empty captions", () => {
    expect(() => assertEnglishOnly("   ")).toThrow(/ENGLISH_ONLY_BLOCK: Empty caption generated/);
  });

  it("blocks obvious Dutch stopwords", () => {
    expect(() => assertEnglishOnly("Dit is een test.")).toThrow(
      /ENGLISH_ONLY_BLOCK: Dutch detected/,
    );
  });

  it("blocks Dutch 'ij' words", () => {
    expect(() => assertEnglishOnly("prijs €10")).toThrow(/ENGLISH_ONLY_BLOCK: Dutch detected/);
  });
});

describe("generateEnglishCaption", () => {
  it("builds an Instagram prompt with strict rules", async () => {
    let capturedSystem = "";
    let capturedPrompt = "";

    const llm = {
      generateText: async ({ system, prompt }: { system: string; prompt: string }) => {
        capturedSystem = system;
        capturedPrompt = prompt;
        return "A lovely find for your home.";
      },
    };

    await expect(
      generateEnglishCaption(llm, {
        platform: "instagram",
        title: "Vintage vase",
        description: "Hand-painted ceramic",
        price: "$25",
        url: "https://example.com/item",
      }),
    ).resolves.toBe("A lovely find for your home.");

    expect(capturedSystem).toContain("Output must be 100% English.");
    expect(capturedPrompt).toContain("Instagram caption rules:");
    expect(capturedPrompt).toContain("Item context:");
    expect(capturedPrompt).toContain("Title: Vintage vase");
    expect(capturedPrompt).toContain("Description: Hand-painted ceramic");
    expect(capturedPrompt).toContain("Price: $25");
    expect(capturedPrompt).toContain("URL: https://example.com/item");
    expect(capturedPrompt).toContain("Do NOT include any URL in the caption.");
  });

  it("builds a Facebook prompt with strict rules", async () => {
    let capturedPrompt = "";

    const llm = {
      generateText: async ({ prompt }: { system: string; prompt: string }) => {
        capturedPrompt = prompt;
        return "Classic, timeless, and ready to display.";
      },
    };

    await expect(
      generateEnglishCaption(llm, {
        platform: "facebook",
        title: "Vintage vase",
      }),
    ).resolves.toBe("Classic, timeless, and ready to display.");

    expect(capturedPrompt).toContain("Facebook caption rules:");
    expect(capturedPrompt).toContain("Minimal hashtags (0 to 2).");
    expect(capturedPrompt).toContain("Do NOT include any URL in the caption.");
  });

  it("blocks Dutch captions returned by the model", async () => {
    const llm = {
      generateText: async () => "Dit is een test.",
    };

    await expect(
      generateEnglishCaption(llm, {
        platform: "facebook",
        title: "Vintage vase",
      }),
    ).rejects.toThrow(/ENGLISH_ONLY_BLOCK: Dutch detected/);
  });
});
