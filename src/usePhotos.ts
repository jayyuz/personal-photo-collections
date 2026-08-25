/**
 * usePhotos — 动态照片数据 hook
 *
 * 从 public/photos.json 读取用户上传的作品（Cloudinary URL）。
 * 合并策略：上传作品（动态）在前，静态 demo 数据在后。
 */
import { useState, useEffect } from 'react';
import { PHOTOS, type Photo, type PhotoSpan } from './data';

interface ApiPhoto {
  id:        string;
  title:     string;
  src:       string;
  span:      string;
  location?: string;
  year?:     number;
  tint:      string;
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
  };
}

export function usePhotos() {
  const [uploadedPhotos, setUploaded] = useState<Photo[]>([]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}photos.json`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ApiPhoto[]) => setUploaded(data.map(toPhoto)))
      .catch(() => {});
  }, []);

  const addPhoto    = (p: Photo) => setUploaded(prev => [p, ...prev]);
  const removePhoto = (id: string) => setUploaded(prev => prev.filter(p => p.id !== id));

  const photos = [...uploadedPhotos, ...PHOTOS];

  return { photos, uploadedPhotos, addPhoto, removePhoto };
}
