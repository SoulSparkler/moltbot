// Drop-in: generate captions in English + block publishing if Dutch appears.

export type LlmClient = {
  generateText: (opts: { system: string; prompt: string }) => Promise<string>;
};

// Lightweight Dutch detector (stopwords + common patterns). Intended to be conservative:
// false positives are safer than accidentally publishing Dutch copy.
const DUTCH_PATTERNS: RegExp[] = [
  /\b(de|het|een|en|van|met|voor|door|uit|bij|als|op|te|niet|wel|maar|ook|nog|naar|om|dat|die|dit|deze|zijn|haar|mijn|jouw|onze|jullie)\b/i,
  /\b(vintage)\s+(italiaanse|franse|keramische|dessertglazen|aardewerk|beeldje|set|middel|zeldzaam|mooi)\b/i,
  /\b(maat|kleur|staat|verzending|kosten|kijk|beschrijving)\b/i,
  /ij/i, // catches lots of Dutch words containing "ij"
];

export function assertEnglishOnly(text: string) {
  const trimmed = (text || "").trim();

  // Empty output should never be posted
  if (!trimmed) {
    throw new Error("ENGLISH_ONLY_BLOCK: Empty caption generated.");
  }

  // Block Dutch-looking text
  for (const re of DUTCH_PATTERNS) {
    if (re.test(trimmed)) {
      throw new Error(`ENGLISH_ONLY_BLOCK: Dutch detected by pattern ${re}. Caption="${trimmed}"`);
    }
  }

  // Optional: block obvious non-English UI leftovers (customize if needed)
  // If you want zero non-English characters anywhere, uncomment:
  // if (/[^\x09\x0A\x0D\x20-\x7E]/.test(trimmed)) {
  //   throw new Error(`ENGLISH_ONLY_BLOCK: Non-ASCII characters found. Caption="${trimmed}"`);
  // }

  return trimmed;
}

export async function generateEnglishCaption(
  llm: LlmClient,
  opts: {
    platform: "facebook" | "instagram";
    title: string;
    description?: string;
    price?: string;
    url?: string;
  },
) {
  const system = [
    "You are a social media copywriter for a vintage shop.",
    "Output must be 100% English.",
    "Never write any Dutch words. Never mix languages.",
    "Do not copy the source text verbatim. Rewrite naturally in US English.",
    "Keep it warm, elegant, and clear for US buyers aged 40+.",
  ].join("\n");

  const platformRules =
    opts.platform === "instagram"
      ? [
          "Instagram caption rules:",
          "- Shorter, more atmospheric.",
          "- Use line breaks.",
          "- End with 3 to 5 relevant hashtags.",
          "- Do NOT include any URL in the caption.",
        ].join("\n")
      : [
          "Facebook caption rules:",
          "- Slightly longer, more descriptive.",
          "- Minimal hashtags (0 to 2).",
          "- Do NOT include any URL in the caption.",
          "- You may include the Etsy link separately via the API 'link' field (not in the text).",
        ].join("\n");

  const prompt = [
    platformRules,
    "",
    "Item context:",
    `Title: ${opts.title}`,
    opts.description ? `Description: ${opts.description}` : "",
    opts.price ? `Price: ${opts.price}` : "",
    opts.url ? `URL: ${opts.url}` : "",
    "",
    "Write one caption that follows the rules exactly.",
  ]
    .filter(Boolean)
    .join("\n");

  const captionRaw = await llm.generateText({ system, prompt });
  return assertEnglishOnly(captionRaw);
}
