// Sharing whiteboard images in a cloud space. The original stays on this
// computer; collaborators get a heavily compressed copy (WebP, at most
// 1600 px and usually well under 400 KB) uploaded to Kern Cloud.

import { api } from "@/lib/ipc";

/** Longest side and quality, tried in order until the result is small enough. */
const LADDER = [
  { max: 1600, q: 0.72 },
  { max: 1280, q: 0.62 },
  { max: 1024, q: 0.55 },
  { max: 800, q: 0.5 },
];
const TARGET_BYTES = 400 * 1024;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  try {
    const bmp = await createImageBitmap(blob);
    return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
  } catch {
    // SVG and some formats only decode through an <img>.
    const url = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image couldn't be read."));
      i.src = url;
    });
    return { source: img, width: img.naturalWidth || 800, height: img.naturalHeight || 600, done: () => URL.revokeObjectURL(url) };
  }
}

function encode(canvas: HTMLCanvasElement, mime: string, q: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, q));
}

function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = Math.min(64, canvas.width);
  probe.height = Math.min(64, canvas.height);
  const ctx = probe.getContext("2d");
  if (!ctx) return true;
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
  return false;
}

export interface Compressed {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
}

/** Downscales and re-encodes an image for sharing. */
export async function compressImage(bytes: Uint8Array, name: string): Promise<Compressed> {
  const img = await decode(new Blob([bytes as BlobPart], { type: mimeOf(name) }));
  try {
    let best: Compressed | null = null;
    for (const step of LADDER) {
      const scale = Math.min(1, step.max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("That image couldn't be processed.");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
      let blob = await encode(canvas, "image/webp", step.q);
      // Some web views can't encode WebP: JPEG when opaque, PNG otherwise.
      if (!blob || blob.type !== "image/webp") blob = hasAlpha(canvas) ? await encode(canvas, "image/png", 1) : await encode(canvas, "image/jpeg", step.q);
      if (!blob) throw new Error("That image couldn't be compressed.");
      best = { blob, mime: blob.type, width: canvas.width, height: canvas.height };
      if (blob.size <= TARGET_BYTES) break;
    }
    return best!;
  } finally {
    img.done();
  }
}

const inflight = new Map<string, Promise<string>>();

/**
 * Compresses a managed image (path relative to the attachments folder) and
 * uploads it to the space. Identical images are stored once on the server.
 */
export function shareImage(space: string, src: string): Promise<string> {
  const key = `${space}:${src}`;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const original = fromBase64(await api.attachments.readBase64(src));
      const c = await compressImage(original, src);
      return api.cloud.uploadAsset(space, await toBase64(c.blob), c.mime, c.width, c.height);
    })();
    inflight.set(key, p);
    // Allow a retry after a failure; keep successes for this session.
    p.catch(() => inflight.delete(key));
  }
  return p;
}
