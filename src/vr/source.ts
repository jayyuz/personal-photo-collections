function cloudinaryTransform(src: string, transform: string): string {
  if (!src.includes('res.cloudinary.com')) return src;
  const hasTransform = /\/upload\/(?:v\d+\/)?[^/]*[_,][^/]*\//.test(src);
  return hasTransform
    ? src.replace(/\/upload\/[^/]+\//, `/upload/${transform}/`)
    : src.replace('/upload/', `/upload/${transform}/`);
}

/**
 * Cloudinary 对「变换结果」有像素上限（常见套餐 25MP）。
 * w_S,h_S,c_limit 最坏情况（方图）就是 S²，所以长边不能超过 sqrt(25MP)。
 */
export const MAX_CLOUDINARY_SIDE = 4800;

/**
 * 把 Cloudinary 地址换成指定宽度 / 质量的版本。
 * 缩略图只关心宽度，保持下载和显存占用较低。
 * 非 Cloudinary 的地址原样返回。
 */
export function cloudinaryVariant(src: string, width: number, quality: number): string {
  return cloudinaryTransform(src, `f_auto,q_${quality},w_${width}`);
}

/**
 * VR 银幕主图：取原图（不做任何缩放变换）。
 *
 * 之前按「照片在屏幕上占多少像素」动态算尺寸，结果测量在部分设备上不稳，
 * 一路算出 512px 的图去填上千像素的位置 —— 糊是必然的。
 * 既然 CDN 上的原图就是高分辨率，直接取原图最省事：省掉整条测量链路，
 * 也不会再有「算错尺寸」这类问题。代价只是流量大一些。
 */
export function cloudinaryOriginal(src: string, quality: number): string {
  return cloudinaryTransform(src, `f_auto,q_${quality}`);
}

/**
 * 按最长边限制取图（备用模式）。
 * 只在「确实要省流量」或「原图超过 GPU 纹理上限」时才有意义。
 */
export function cloudinaryFit(
  src: string,
  maxSize: number,
  quality: number,
  sharpen = 0
): string {
  const side = Math.max(64, Math.min(MAX_CLOUDINARY_SIDE, Math.round(maxSize)));
  const parts = [`f_auto`, `q_${quality}`, `w_${side}`, `h_${side}`, `c_limit`];
  if (sharpen > 0) parts.push(`e_sharpen:${Math.round(sharpen)}`);
  return cloudinaryTransform(src, parts.join(','));
}
