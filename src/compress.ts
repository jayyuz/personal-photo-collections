/**
 * compress — 超过上传上限的图，先在浏览器里压一压
 *
 * 走 canvas 重编码：先降质量、质量降到底还超就把长边再缩一档，
 * 直到压进目标体积。优先 WebP（同样画质体积小，且能保留透明通道），
 * 不支持时退回 JPEG。
 */
export interface Compressed {
  blob:   Blob;
  width:  number;
  height: number;
}

/** 长边上限，超过就先缩到这个尺寸再谈质量 */
const MAX_SIDE = 4096;
const QUALITY_STEPS = [0.9, 0.82, 0.72, 0.62, 0.5, 0.4];
const SCALE_STEPS   = [1, 0.8, 0.65, 0.5, 0.4];

function supportsWebp(): boolean {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/** 解码原图：优先 createImageBitmap（顺带修正 EXIF 旋转），不支持时退回 <img> */
async function decode(file: File): Promise<{
  source: CanvasImageSource; width: number; height: number; revoke: () => void;
} | undefined> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bmp,
        width:  bmp.width,
        height: bmp.height,
        revoke: () => bmp.close(),
      };
    } catch {
      /* 继续走下面的兜底 */
    }
  }

  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement | undefined>(resolve => {
    const el = new Image();
    el.onload  = () => resolve(el);
    el.onerror = () => resolve(undefined);
    el.src = url;
  });
  if (!img) { URL.revokeObjectURL(url); return undefined; }
  return {
    source: img,
    width:  img.naturalWidth,
    height: img.naturalHeight,
    revoke: () => URL.revokeObjectURL(url),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(b => resolve(b), type, quality));
}

/**
 * 把 file 压到 targetBytes 以内。
 * 压不到就返回缩到最小、质量最低的那一份，由调用方决定要不要用。
 */
export async function compressImage(file: File, targetBytes: number): Promise<Compressed | undefined> {
  const decoded = await decode(file);
  if (!decoded) return undefined;

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const type = supportsWebp() ? 'image/webp' : 'image/jpeg';
    const base = Math.min(1, MAX_SIDE / Math.max(decoded.width, decoded.height));
    let smallest: Compressed | undefined;

    for (const scale of SCALE_STEPS) {
      const ratio = base * scale;
      const w = Math.max(1, Math.round(decoded.width  * ratio));
      const h = Math.max(1, Math.round(decoded.height * ratio));
      canvas.width = w;
      canvas.height = h;
      // JPEG 不支持透明通道，先铺白底，避免透明区域变黑
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      ctx.drawImage(decoded.source, 0, 0, w, h);

      for (const q of QUALITY_STEPS) {
        const blob = await toBlob(canvas, type, q);
        if (!blob) continue;
        if (blob.size <= targetBytes) return { blob, width: w, height: h };
        if (!smallest || blob.size < smallest.blob.size) smallest = { blob, width: w, height: h };
      }
    }
    return smallest;
  } finally {
    decoded.revoke();
  }
}
