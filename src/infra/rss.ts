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

function urlHostOrNull(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

function isEtsystaticHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "etsystatic.com" || normalized.endsWith(".etsystatic.com");
}

export function extractRssImgSrc(descriptionHtml: string | null | undefined): string | null {
  const html = typeof descriptionHtml === "string" ? descriptionHtml.trim() : "";
  if (!html) {
    return null;
  }

  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  let firstHttpUrl: string | null = null;
  for (const tag of tags) {
    const src = normalizeHttpUrl(getHtmlAttribute(tag, "src"));
    if (!src) {
      continue;
    }

    firstHttpUrl ??= src;

    const host = urlHostOrNull(src);
    if (host && isEtsystaticHost(host)) {
      return src;
    }
  }

  return firstHttpUrl;
}
