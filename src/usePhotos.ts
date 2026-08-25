/**
 * usePhotos — 照片数据 hook
 *
 * 唯一数据源是 public/photos.json（由管理面板写入，Cloudinary URL）。
 */
import { useState, useEffect } from 'react';
import type { Photo, PhotoExif, PhotoSpan } from './data';

interface ApiPhoto {
  id:        string;
  title:     string;
  src:       string;
  span:      string;
  location?: string;
  year?:     number;
  tint:      string;
  cover?:    boolean;
  exif?:     PhotoExif;
}

export function toPhoto(p: ApiPhoto): Photo {
  return {
    id:       p.id,
    title:    p.title,
    src:      p.src,
    span:     (p.span as PhotoSpan) || 'normal',
    location: p.location || undefined,
    year:     p.year     || undefined,
    tint:     p.tint,
    cover:    p.cover || undefined,
    exif:     p.exif  || undefined,
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

  const coverPhoto = photos.find(p => p.cover) ?? photos[0];

  return { photos, coverPhoto, addPhotos, removePhoto, setCover };
}
