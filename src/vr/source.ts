function cloudinaryTransform(src: string, transform: string): string {
  if (!src.includes('res.cloudinary.com')) return src;
  const hasTransform = /\/upload\/(?:v\d+\/)?[^/]*[_,][^/]*\//.test(src);
  return hasTransform
    ? src.replace(/\/upload\/[^/]+\//, `/upload/${transform}/`)
    : src.replace('/upload/', `/upload/${transform}/`);
}

/**
 * 把 Cloudinary 地址换成指定宽度 / 质量的版本。
 * 缩略图只关心宽度，保持下载和显存占用较低。
 * 非 Cloudinary 的地址原样返回。
 */
export function cloudinaryVariant(src: string, width: number, quality: number): string {
  return cloudinaryTransform(src, `f_auto,q_${quality},w_${width}`);
}

/**
 * VR 银幕主图按最长边限制，避免竖图因为只限制宽度而超过 WebGL 最大纹理，
 * 同时比站点上的 w_1600 有更高细节。
 */
export function cloudinaryMaxVariant(src: string, maxSize: number, quality: number): string {
  return cloudinaryTransform(src, `f_auto,q_${quality},w_${maxSize},h_${maxSize},c_limit`);
}
