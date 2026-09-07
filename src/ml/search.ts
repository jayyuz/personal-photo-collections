import type { Photo } from '../data';
import { cosine } from './imageSrc';
import { embedText, type ClipProgress } from './clip';
import { THEME_LABELS } from './tagging';

const SUBSTR_W = 0.15;
const TAG_W = 0.35;

function haystack(p: Photo): string {
  return [p.title, p.location, p.year, ...(p.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
}

export function filterByChip(photos: Photo[], chip: string): Photo[] {
  const c = chip.trim();
  if (!c) return photos;
  const tagged = photos.filter(p => p.tags?.includes(c));
  if (tagged.length) return tagged;
  return photos.filter(p => haystack(p).includes(c.toLowerCase()));
}

export function localScore(photo: Photo, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const h = haystack(photo);
  if (h.includes(q)) return 1;
  const parts = q.split(/\s+/).filter(Boolean);
  let n = 0;
  for (const part of parts) if (h.includes(part)) n += 1;
  return parts.length ? n / parts.length : 0;
}

export async function rankPhotos(
  photos: Photo[],
  query: string,
  onProgress?: ClipProgress,
): Promise<Photo[]> {
  const q = query.trim();
  if (!q) return photos;

  const withVec = photos.filter(p => p.embedding?.length);
  if (!withVec.length) {
    return [...photos].sort((a, b) => localScore(b, q) - localScore(a, q));
  }

  onProgress?.('正在理解检索词…');
  const qv = await embedText(q, onProgress);
  return [...photos]
    .map(p => {
      const sem = p.embedding?.length ? cosine(p.embedding, qv) : 0;
      const loc = localScore(p, q);
      const tag = p.tags?.some(t => t === q || q.includes(t)) ? TAG_W : 0;
      return { p, s: sem + loc * SUBSTR_W + tag };
    })
    .sort((a, b) => b.s - a.s)
    .map(x => x.p);
}

export function similarTo(photo: Photo, photos: Photo[], limit = 6): Photo[] {
  if (!photo.embedding?.length) return [];
  return photos
    .filter(p => p.id !== photo.id && p.embedding?.length)
    .map(p => ({ p, s: cosine(photo.embedding!, p.embedding!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.p);
}

export { THEME_LABELS };
