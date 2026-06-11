// Validation for client-supplied images. The WebSocket payload is untrusted
// input: without these caps a raw client could push arbitrarily large base64
// blobs straight into the model context (cost + memory).
export interface ImageInput {
  type: "image";
  data: string; // base64
  mimeType: string;
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
// ~6 MB of binary per image (base64 inflates 4/3) — far above any phone photo
// after the frontend's downscale, low enough to bound a hostile payload.
const MAX_BASE64_CHARS = 8_000_000;

export function sanitizeImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (img: any) =>
        img &&
        typeof img.data === "string" &&
        img.data.length > 0 &&
        img.data.length <= MAX_BASE64_CHARS &&
        ALLOWED_MIME.has(img.mimeType),
    )
    .slice(0, MAX_IMAGES)
    .map((img: any) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
}