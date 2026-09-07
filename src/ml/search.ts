/**
 * 访客侧检索 —— 全部在本地算，一个模型都不下载。
 *
 * 重活都在 Admin 侧做完了：主题标签和图像向量已经写进 photos.json。
 * 这里主题 chip 直接按标签过滤，输入框按标题/标签/地点年份匹配，
 * 灯箱的相似推荐比对存好的向量。
 *
 * 之所以不做中文语义检索：MobileCLIP 只认英文，而能读中文的模型
 * （SigLIP 2）文本塔要 283 MB，让每个想搜个词的访客都下一遍不划算。
 */
import type { Photo } from '../data';
import { cosine } from './imageSrc';
import { THEME_LABELS, type ThemeLabel } from './tagging';

/** 命中标题最有说服力，其次标签，地点年份垫底 */
const FIELD_WEIGHTS = { title: 1, tags: 0.8, meta: 0.6 };

function fields(p: Photo): [string, number][] {
  return [
    [p.title.toLowerCase(), FIELD_WEIGHTS.title],
    [(p.tags ?? []).join(' ').toLowerCase(), FIELD_WEIGHTS.tags],
    [`${p.location ?? ''} ${p.year ?? ''}`.toLowerCase(), FIELD_WEIGHTS.meta],
  ];
}

/** 0 表示没沾边，越大越像；多个词按命中比例平均，全中才拿满分 */
export function localScore(photo: Photo, query: string): number {
  const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return 0;
  const f = fields(photo);
  let total = 0;
  for (const part of parts) {
    let best = 0;
    for (const [text, weight] of f) {
      if (text.includes(part)) best = Math.max(best, weight);
    }
    total += best;
  }
  return total / parts.length;
}

export function filterByChip(photos: Photo[], chip: string): Photo[] {
  const c = chip.trim();
  if (!c) return photos;
  const tagged = photos.filter(p => p.tags?.includes(c));
  // 没打过标的图库也别让 chip 变成死按钮，退回字段匹配
  if (tagged.length) return tagged;
  return photos.filter(p => localScore(p, c) > 0);
}

export function searchPhotos(photos: Photo[], query: string): Photo[] {
  if (!query.trim()) return photos;
  return photos
    .map(p => ({ p, s: localScore(p, query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.p);
}

/** 只把图库里真出现过的主题做成 chip，免得点开一堆空结果 */
export function availableThemes(photos: Photo[]): ThemeLabel[] {
  const present = new Set(photos.flatMap(p => p.tags ?? []));
  return THEME_LABELS.filter(label => present.has(label));
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
export type { ThemeLabel };
