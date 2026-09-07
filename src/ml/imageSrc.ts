/**
 * 推理用缩略图：Cloudinary 原图太大，缩到短边 384 即可。
 * 不改动站点展示用的 src。
 */
export function mlImageSrc(src: string): string {
  const marker = '/upload/';
  const i = src.indexOf(marker);
  if (i < 0) return src;
  const after = src.slice(i + marker.length);
  const slash = after.indexOf('/');
  if (slash < 0) return src;
  const maybeTx = after.slice(0, slash);
  const rest = after.slice(slash + 1);
  // 已有变换段（含逗号或 f_auto 等）就整段换掉；否则在版本号前插入
  if (/[,_]/.test(maybeTx) || maybeTx.startsWith('f_') || maybeTx.startsWith('w_') || maybeTx.startsWith('q_')) {
    return `${src.slice(0, i + marker.length)}w_384,c_limit,q_auto,f_auto/${rest}`;
  }
  return `${src.slice(0, i + marker.length)}w_384,c_limit,q_auto,f_auto/${after}`;
}

export function compactEmbedding(data: ArrayLike<number>): number[] {
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * 1e4) / 1e4;
  return out;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
