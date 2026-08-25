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

export function usePhotos() {
  const [photos, setPhotos] = useState<Photo[]>([]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}photos.json`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ApiPhoto[]) => setPhotos(data.map(toPhoto)))
      .catch(() => {});
  }, []);

  const addPhotos   = (list: Photo[]) => setPhotos(prev => [...list, ...prev]);
  const removePhoto = (id: string) => setPhotos(prev => prev.filter(p => p.id !== id));
  const setCover    = (id: string) =>
    setPhotos(prev => prev.map(p => ({ ...p, cover: p.id === id || undefined })));

  const coverPhoto = photos.find(p => p.cover) ?? photos[0];

  return { photos, coverPhoto, addPhotos, removePhoto, setCover };
}
