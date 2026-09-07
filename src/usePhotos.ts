/**
 * usePhotos — 照片数据 hook
 *
 * 唯一数据源是 public/photos.json（由管理面板写入，Cloudinary URL）。
 */
import { useState, useEffect } from 'react';
import type { Photo, PhotoExif, PhotoFocus, PhotoSpan } from './data';
import { EMBED_MODEL } from './ml/clip';

export interface ApiPhoto {
  id:        string;
  title:     string;
  src:       string;
  span:      string;
  location?: string;
  year?:     number;
  tint:      string;
  cover?:    boolean;
  exif?:     PhotoExif;
  tags?:     string[];
  embedding?: number[];
  embedModel?: string;
  focus?:    PhotoFocus;
  aesthetic?: number;
}

function finiteFocus(f?: PhotoFocus): PhotoFocus | undefined {
  if (!f) return undefined;
  if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) return undefined;
  return {
    x: Math.min(1, Math.max(0, f.x)),
    y: Math.min(1, Math.max(0, f.y)),
  };
}

export function toPhoto(p: ApiPhoto): Photo {
  // 换模型后旧向量维度可能碰巧还一样，语义空间却已经不同。在数据入口就丢掉，
  // 检索、相似推荐、Admin 的待索引计数便一次性都看到正确的状态。
  const usableVec = !!p.embedding?.length && p.embedModel === EMBED_MODEL;
  return {
    id:        p.id,
    title:     p.title,
    src:       p.src,
    span:      (p.span as PhotoSpan) || 'normal',
    location:  p.location || undefined,
    year:      p.year     || undefined,
    tint:      p.tint,
    cover:     p.cover || undefined,
    exif:      p.exif  || undefined,
    tags:      p.tags?.length ? p.tags : undefined,
    embedding: usableVec ? p.embedding : undefined,
    embedModel: usableVec ? p.embedModel : undefined,
    focus:     finiteFocus(p.focus),
    aesthetic: Number.isFinite(p.aesthetic) ? p.aesthetic : undefined,
  };
}

/**
 * photos.json 是管理面板随时改写的静态文件，浏览器 HTTP 缓存和 Pages 的 CDN
 * 都会按静态资源缓存它。no-store 绕过浏览器缓存，时间戳让 CDN 的缓存键失效，
 * 两者都需要：只有 no-store 时 CDN 仍可能回旧内容。
 */
function photosUrl() {
  return `${import.meta.env.BASE_URL}photos.json?t=${Date.now()}`;
}

export function usePhotos() {
  const [photos, setPhotos] = useState<Photo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(photosUrl(), { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : []))
        .then((data: ApiPhoto[]) => {
          if (!cancelled && Array.isArray(data)) setPhotos(data.map(toPhoto));
        })
        .catch(() => {});
    };
    load();

    // 回到页面时重新拉一次，刚发布的照片不用手动刷新就能看到
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const addPhotos   = (list: Photo[]) => setPhotos(prev => [...list, ...prev]);
  const removePhoto = (id: string) => setPhotos(prev => prev.filter(p => p.id !== id));
  const setCover    = (id: string) =>
    setPhotos(prev => prev.map(p => ({ ...p, cover: p.id === id || undefined })));
  /** 按 id 就地替换，用于重排布局这类只改字段的批量更新 */
  const updatePhotos = (list: Photo[]) =>
    setPhotos(prev => prev.map(p => list.find(n => n.id === p.id) ?? p));

  const coverPhoto = photos.find(p => p.cover) ?? photos[0];

  return { photos, coverPhoto, addPhotos, removePhoto, setCover, updatePhotos };
}
