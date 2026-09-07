import { DEFAULT_TINT, TINT_OPTS } from '../tints';

function hueInRange(h: number, range: [number, number] | null): boolean {
  if (!range) return false;
  const [a, b] = range;
  if (a <= b) return h >= a && h < b;
  return h >= a || h < b;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max / 255 };
}

/**
 * 从画面抽主色，映射到现有八档 tint。不依赖模型。
 */
export async function tintFromImage(src: string): Promise<string> {
  const img = await loadImg(src);
  const canvas = document.createElement('canvas');
  const size = 32;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return DEFAULT_TINT;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const buckets = TINT_OPTS.map(() => 0);
  let gray = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (v < 18 || v > 245) continue;
    if (s < 0.12) { gray += 1; continue; }
    let best = 0;
    for (let b = 0; b < TINT_OPTS.length; b++) {
      const range = TINT_OPTS[b].hues;
      if (range && hueInRange(h, range as [number, number])) { best = b; break; }
    }
    buckets[best] += s * (0.4 + v / 255);
  }

  const colorSum = buckets.reduce((a, b) => a + b, 0);
  if (colorSum < gray * 0.35) {
    const grayOpt = TINT_OPTS.find(o => o.label.startsWith('中性'));
    return grayOpt?.value ?? DEFAULT_TINT;
  }
  let idx = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i] > buckets[idx]) idx = i;
  return TINT_OPTS[idx].value;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('读图失败，无法取色'));
    img.src = src;
  });
}
