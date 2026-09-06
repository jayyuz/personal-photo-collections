/**
 * 把 Cloudinary 地址换成指定宽度 / 质量的版本。
 * 站点上存的是 w_1600 + q_auto，VR 大银幕和缩略图各需要不同规格。
 * 非 Cloudinary 的地址原样返回。
 */
export function cloudinaryVariant(src: string, width: number, quality: number): string {
  if (!src.includes('res.cloudinary.com')) return src;
  const hasTransform = /\/upload\/(?:v\d+\/)?[^/]*[_,][^/]*\//.test(src);
  if (!hasTransform) {
    return src.replace('/upload/', `/upload/f_auto,q_${quality},w_${width}/`);
  }
  return src
    .replace(/\bw_\d+\b/, `w_${width}`)
    .replace(/\bq_[\w:]+\b/, `q_${quality}`);
}
