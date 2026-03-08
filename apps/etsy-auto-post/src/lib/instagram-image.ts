/**
 * Instagram image validation and transformation for Etsy listing photos.
 *
 * Instagram Content Publishing API constraints:
 * - Image must be JPEG or PNG
 * - Width: 320–1440 px
 * - Aspect ratio: 4:5 (0.8) to 1.91:1
 * - Must be a publicly accessible URL
 */

const IG_MIN_RATIO = 4 / 5; // 0.8  — tallest allowed portrait
const IG_MAX_RATIO = 1.91; //        — widest allowed landscape
const IG_MIN_WIDTH = 320;
const IG_MAX_WIDTH = 1440;
const IG_IDEAL_WIDTH = 1080;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageProbeResult = {
  width: number;
  height: number;
  aspectRatio: number;
  format: "jpeg" | "png" | "unknown";
  contentType: string | null;
  byteLength: number;
  buffer: Buffer;
};

export type InstagramImageValidation = {
  originalUrl: string;
  sanitizedUrl: string;
  urlChanged: boolean;
  probe: Omit<ImageProbeResult, "buffer"> | null;
  probeError: string | null;
  ratioOk: boolean;
  dimensionsOk: boolean;
  needsTransform: boolean;
};

export type PaddingSpec = {
  targetWidth: number;
  targetHeight: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
};

// ---------------------------------------------------------------------------
// URL sanitization
// ---------------------------------------------------------------------------

/**
 * Decode all HTML entities that might appear in an og:image or RSS img src,
 * including numeric (&#123;) and hex (&#xAB;) character references.
 */
function decodeAllHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    );
}

/**
 * Sanitize an image URL before sending it to Instagram:
 * - Decode residual HTML entities (og:image often contains &amp;)
 * - Upgrade http → https
 * - Fix protocol-relative URLs
 * - Normalise via the URL constructor
 */
export function sanitizeInstagramImageUrl(raw: string): string {
  let url = raw.trim();

  // Decode any remaining HTML entities (common in og:image values)
  url = decodeAllHtmlEntities(url);

  // Fix protocol-relative URLs
  if (url.startsWith("//")) {
    url = "https:" + url;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Image dimension probing (pure Node — no external deps)
// ---------------------------------------------------------------------------

function readPngDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  // PNG header: 0x89504E47, IHDR chunk starts at offset 8, width@16, height@20
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function readJpegDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < buf.length - 9) {
    // Find next marker
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    // SOF markers: 0xC0–0xCF except 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC)
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    // Skip segment
    if (offset + 3 < buf.length) {
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    } else {
      break;
    }
  }
  return null;
}

function readImageDimensions(buf: Buffer): {
  width: number;
  height: number;
  format: "jpeg" | "png";
} | null {
  const png = readPngDimensions(buf);
  if (png) {
    return { ...png, format: "png" };
  }

  const jpeg = readJpegDimensions(buf);
  if (jpeg) {
    return { ...jpeg, format: "jpeg" };
  }

  return null;
}

/**
 * Download an image and read its dimensions from the binary header.
 * Returns the full buffer so it can be reused for padding without a second fetch.
 */
export async function probeImageDimensions(
  imageUrl: string,
  fetchImpl?: typeof fetch,
): Promise<ImageProbeResult> {
  const f = fetchImpl ?? globalThis.fetch;
  const response = await f(imageUrl, {
    method: "GET",
    headers: { Accept: "image/*" },
  });

  if (!response.ok) {
    throw new Error(
      `Image fetch failed: status=${response.status} url=${imageUrl}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? null;
  const buffer = Buffer.from(await response.arrayBuffer());

  const dims = readImageDimensions(buffer);
  if (!dims) {
    throw new Error(
      `Could not read dimensions from image: contentType=${contentType} bytes=${buffer.length}`,
    );
  }

  return {
    width: dims.width,
    height: dims.height,
    aspectRatio: dims.width / dims.height,
    format: dims.format,
    contentType,
    byteLength: buffer.length,
    buffer,
  };
}

// ---------------------------------------------------------------------------
// Aspect-ratio validation
// ---------------------------------------------------------------------------

/** Small tolerance to avoid rejecting images that are right at the boundary. */
const RATIO_TOLERANCE = 0.01;

export function isInstagramSafeAspectRatio(
  width: number,
  height: number,
): boolean {
  if (width <= 0 || height <= 0) {return false;}
  const ratio = width / height;
  return (
    ratio >= IG_MIN_RATIO - RATIO_TOLERANCE &&
    ratio <= IG_MAX_RATIO + RATIO_TOLERANCE
  );
}

/**
 * Compute the padding (white letterbox / pillarbox) needed to bring an image
 * into Instagram's accepted aspect-ratio range.
 */
export function computeInstagramPadding(
  width: number,
  height: number,
): PaddingSpec {
  const ratio = width / height;

  if (ratio < IG_MIN_RATIO) {
    // Too tall — add horizontal (left+right) padding to widen
    const targetWidth = Math.ceil(height * IG_MIN_RATIO);
    const totalPad = targetWidth - width;
    const padLeft = Math.floor(totalPad / 2);
    const padRight = totalPad - padLeft;
    return { targetWidth, targetHeight: height, padLeft, padRight, padTop: 0, padBottom: 0 };
  }

  if (ratio > IG_MAX_RATIO) {
    // Too wide — add vertical (top+bottom) padding to heighten
    const targetHeight = Math.ceil(width / IG_MAX_RATIO);
    const totalPad = targetHeight - height;
    const padTop = Math.floor(totalPad / 2);
    const padBottom = totalPad - padTop;
    return { targetWidth: width, targetHeight, padLeft: 0, padRight: 0, padTop, padBottom };
  }

  return { targetWidth: width, targetHeight: height, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 };
}

// ---------------------------------------------------------------------------
// Image padding with sharp (dynamic import — graceful fallback)
// ---------------------------------------------------------------------------

type SharpModule = typeof import("sharp");
let sharpCache: SharpModule | null | "unavailable" = null;

async function loadSharp(): Promise<SharpModule | null> {
  if (sharpCache === "unavailable") {return null;}
  if (sharpCache) {return sharpCache;}
  try {
    const mod = await import("sharp");
    sharpCache = mod.default as unknown as SharpModule;
    return sharpCache;
  } catch {
    sharpCache = "unavailable";
    return null;
  }
}

/**
 * Pad an image buffer with a white background so it fits Instagram's
 * aspect-ratio constraints.  Returns the padded JPEG buffer.
 *
 * Requires `sharp` to be installed — returns `null` if unavailable.
 */
export async function padImageForInstagram(
  imageBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }

  const pad = computeInstagramPadding(width, height);
  if (pad.padLeft === 0 && pad.padRight === 0 && pad.padTop === 0 && pad.padBottom === 0) {
    // No padding needed — return as-is
    return imageBuffer;
  }

  let pipeline = sharp(imageBuffer).extend({
    top: pad.padTop,
    bottom: pad.padBottom,
    left: pad.padLeft,
    right: pad.padRight,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  });

  // Downscale to IG_MAX_WIDTH if the padded result is too wide
  if (pad.targetWidth > IG_MAX_WIDTH) {
    pipeline = pipeline.resize({ width: IG_MAX_WIDTH, withoutEnlargement: true });
  }

  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

/**
 * Resize an image to fit within Instagram's width limits (320–1440 px).
 * Only applied when the image is wider than 1440 px or narrower than 320 px.
 *
 * Requires `sharp` — returns `null` if unavailable.
 */
export async function resizeImageForInstagram(
  imageBuffer: Buffer,
  width: number,
): Promise<{ buffer: Buffer; resized: boolean } | null> {
  const sharp = await loadSharp();
  if (!sharp) {return null;}

  if (width > IG_MAX_WIDTH) {
    const buf = await sharp(imageBuffer)
      .resize({ width: IG_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { buffer: buf, resized: true };
  }

  if (width < IG_MIN_WIDTH) {
    const buf = await sharp(imageBuffer)
      .resize({ width: IG_MIN_WIDTH, withoutEnlargement: false })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { buffer: buf, resized: true };
  }

  return { buffer: imageBuffer, resized: false };
}

// ---------------------------------------------------------------------------
// Combined validation helper
// ---------------------------------------------------------------------------

export async function validateInstagramImage(
  imageUrl: string,
  fetchImpl?: typeof fetch,
): Promise<InstagramImageValidation> {
  const sanitizedUrl = sanitizeInstagramImageUrl(imageUrl);
  const urlChanged = sanitizedUrl !== imageUrl;

  let probe: ImageProbeResult | null = null;
  let probeError: string | null = null;

  try {
    probe = await probeImageDimensions(sanitizedUrl, fetchImpl);
  } catch (err) {
    probeError = String(err);
  }

  const ratioOk = probe
    ? isInstagramSafeAspectRatio(probe.width, probe.height)
    : false;
  const dimensionsOk = probe
    ? probe.width >= IG_MIN_WIDTH && probe.width <= IG_MAX_WIDTH
    : false;
  const needsTransform = probe ? !ratioOk || !dimensionsOk : false;

  return {
    originalUrl: imageUrl,
    sanitizedUrl,
    urlChanged,
    probe: probe
      ? {
          width: probe.width,
          height: probe.height,
          aspectRatio: probe.aspectRatio,
          format: probe.format,
          contentType: probe.contentType,
          byteLength: probe.byteLength,
        }
      : null,
    probeError,
    ratioOk,
    dimensionsOk,
    needsTransform,
  };
}

// ---------------------------------------------------------------------------
// Temp image store (in-memory, auto-expiring)
// ---------------------------------------------------------------------------

type TempImageEntry = {
  buffer: Buffer;
  contentType: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const tempImageStore = new Map<string, TempImageEntry>();
const TEMP_IMAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function storeTempImage(
  id: string,
  buffer: Buffer,
  contentType: string,
): void {
  clearTempImage(id);
  const timer = setTimeout(() => {
    tempImageStore.delete(id);
  }, TEMP_IMAGE_TTL_MS);
  // Allow the process to exit even if the timer is pending
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
  tempImageStore.set(id, { buffer, contentType, createdAt: Date.now(), timer });
}

export function getTempImage(
  id: string,
): { buffer: Buffer; contentType: string } | null {
  const entry = tempImageStore.get(id);
  return entry ? { buffer: entry.buffer, contentType: entry.contentType } : null;
}

export function clearTempImage(id: string): void {
  const existing = tempImageStore.get(id);
  if (existing) {
    clearTimeout(existing.timer);
    tempImageStore.delete(id);
  }
}
