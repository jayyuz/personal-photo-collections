/** 零样本词表：打标、画廊主题 chip、标题兜底共用这一份 */
export const THEME_LABELS = [
  '人像', '街拍', '风景', '花卉', '建筑', '夜景', '静物', '人文', '微距', '城市',
] as const;

export type ThemeLabel = (typeof THEME_LABELS)[number];

const GENERIC_TITLE = /^(DSC|IMG|DCIM|P\d+|PHOTO|image|untitled|微信图片|mmexport)/i;

export function isGenericTitle(title: string): boolean {
  const t = title.replace(/[\s_-]+/g, '');
  return GENERIC_TITLE.test(t);
}

export function titleFromTags(tags: string[], fallback: string): string {
  if (!tags.length) return fallback;
  return tags[0];
}

const TAG_MIN = 0.12;
const TAG_MAX = 3;

export function pickTags(scored: { label: string; score: number }[]): string[] {
  if (!scored.length) return [];
  const top = scored[0].score;
  const picked = scored
    .filter(s => s.score >= Math.max(TAG_MIN, top - 0.08))
    .slice(0, TAG_MAX)
    .map(s => s.label);
  return picked.length ? picked : [scored[0].label];
}
