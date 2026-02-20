export type EtsyListingImageUrlExtraction = {
  url: string;
  source: "og_image" | "json_ld";
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as JsonRecord;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function getHtmlAttribute(tag: string, attributeName: string): string | null {
  const name = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i");
  const match = re.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (typeof value !== "string") {
    return null;
  }
  const decoded = decodeBasicHtmlEntities(value);
  const trimmed = decoded.trim();
  return trimmed ? trimmed : null;
}

function normalizeHttpUrl(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return trimmed;
}

function extractOgImageUrlFromHtml(html: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const property = getHtmlAttribute(tag, "property")?.toLowerCase();
    if (property !== "og:image") {
      continue;
    }
    const content = normalizeHttpUrl(getHtmlAttribute(tag, "content"));
    if (content) {
      return content;
    }
  }
  return null;
}

function tryExtractImageFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeHttpUrl(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = tryExtractImageFromValue(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return (
    tryExtractImageFromValue(record.url) ??
    tryExtractImageFromValue(record.contentUrl) ??
    tryExtractImageFromValue(record["@id"])
  );
}

function extractImageUrlFromJsonLdNode(node: unknown, depth: number): string | null {
  if (depth <= 0) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = extractImageUrlFromJsonLdNode(entry, depth - 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(node);
  if (!record) {
    return null;
  }

  if (Object.hasOwn(record, "image")) {
    const candidate = tryExtractImageFromValue(record.image);
    if (candidate) {
      return candidate;
    }
  }

  if (Object.hasOwn(record, "@graph")) {
    const candidate = extractImageUrlFromJsonLdNode(record["@graph"], depth - 1);
    if (candidate) {
      return candidate;
    }
  }

  for (const value of Object.values(record)) {
    const candidate = extractImageUrlFromJsonLdNode(value, depth - 1);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractJsonLdImageUrlFromHtml(html: string): string | null {
  const re =
    /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const raw = match[1]?.trim() ?? "";
    if (!raw) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }

    const found = extractImageUrlFromJsonLdNode(parsed, 14);
    if (found) {
      return found;
    }
  }

  return null;
}

export function extractEtsyListingImageUrlFromHtml(
  html: string,
): EtsyListingImageUrlExtraction | null {
  const ogImage = extractOgImageUrlFromHtml(html);
  if (ogImage) {
    return { url: ogImage, source: "og_image" };
  }

  const jsonLdImage = extractJsonLdImageUrlFromHtml(html);
  if (jsonLdImage) {
    return { url: jsonLdImage, source: "json_ld" };
  }

  return null;
}
