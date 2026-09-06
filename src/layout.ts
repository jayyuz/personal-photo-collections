/**
 * layout — 按图片真实宽高比自动挑选格子
 *
 * bento 网格基准单元格约为 1.3:1（4 列 × --cell 280px，见 index.css），
 * 所以：接近基准的放普通格，明显更宽的放 2×1，明显更高的放 1×2，
 * 方图且分辨率够高时给 2×2 大图，让画面有节奏。
 */
import type { PhotoExif, PhotoSpan } from './data';

export interface ImageSize {
  width:  number;
  height: number;
}

export const SPAN_OPTIONS: { value: PhotoSpan; label: string }[] = [
  { value: 'normal', label: '普通 1×1' },
  { value: 'wide',   label: '宽幅 2×1' },
  { value: 'tall',   label: '高幅 1×2' },
  { value: 'big',    label: '大图 2×2' },
];

export const SPAN_LABEL: Record<PhotoSpan, string> = {
  normal: '普通 1×1',
  wide:   '宽幅 2×1',
  tall:   '高幅 1×2',
  big:    '大图 2×2',
};

/** 16:9 及以上算宽幅；4:5 及以下算高幅；中间归普通格 */
const WIDE_FROM = 1.7;
const TALL_TO   = 0.8;
/** 方图容差与放大成 2×2 的最低像素（低于此值放大后会糊） */
const BIG_TOLERANCE = 0.12;
const BIG_MIN_SIDE  = 1200;

export function spanFromSize(size?: ImageSize): PhotoSpan {
  if (!size || !size.width || !size.height) return 'normal';
  const ratio = size.width / size.height;
  if (ratio >= WIDE_FROM) return 'wide';
  if (ratio <= TALL_TO)   return 'tall';
  if (Math.abs(ratio - 1) <= BIG_TOLERANCE &&
      Math.min(size.width, size.height) >= BIG_MIN_SIDE) return 'big';
  return 'normal';
}

/** EXIF 里的尺寸可能未随旋转修正，只在测不出真实尺寸时兜底 */
export function sizeFromExif(exif?: PhotoExif): ImageSize | undefined {
  if (!exif?.width || !exif?.height) return undefined;
  return { width: exif.width, height: exif.height };
}

/** 解析一张图的真实宽高；失败或超时返回 undefined */
export function sizeFromSrc(src: string, timeoutMs = 15000): Promise<ImageSize | undefined> {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const finish = (size?: ImageSize) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(size);
    };
    const timer = setTimeout(() => { img.src = ''; finish(undefined); }, timeoutMs);
    img.onload  = () => finish(
      img.naturalWidth && img.naturalHeight
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : undefined
    );
    img.onerror = () => finish(undefined);
    img.src = src;
  });
}

/** 本地文件优先 createImageBitmap（不用整图解码），不支持时退回 objectURL */
export async function sizeFromFile(file: File): Promise<ImageSize | undefined> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return size;
    } catch {
      /* 继续走下面的兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await sizeFromSrc(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
