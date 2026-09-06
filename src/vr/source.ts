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
 * VR 银幕主图：按最长边限制，避免竖图因为只限制宽度而超过 WebGL 最大纹理。
 *
 * 关键是 size 要贴着「这张图在头显面板上实际占多少像素」来取，而不是一味往大要：
 * 交给 Cloudinary 做 Lanczos 下采样 + 轻锐化，比下载一张巨图再让 GPU
 * 用 mipmap（盒式滤波）缩下去清晰得多，下载量也小一个量级。
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
