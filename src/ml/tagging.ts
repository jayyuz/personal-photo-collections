/** 零样本词表：打标、画廊主题 chip、标题兜底共用这一份 */
import { scoreGroups, type ClipProgress, type LabelScore } from './clip';

export const THEME_LABELS = [
  '人像', '街拍', '风景', '花卉', '建筑', '夜景', '静物', '人文', '微距', '城市',
] as const;

export type ThemeLabel = (typeof THEME_LABELS)[number];

/**
 * 提示词是英文的，MobileCLIP 只在英文语料上训练过。标签本身仍是中文，
 * 存进 photos.json、显示在 chip 上的都是左边这一列，用户看不到英文。
 *
 * 每个标签配几句完整的描述而不是一个词：CLIP 比的是「图和这句话像不像」，
 * 光给 "portrait" 它分不清是要画面里有人、还是要某种画风。句子里点明
 * 画面里有什么、没有什么，区分度会高很多。
 */
const THEME_PROMPTS: Record<ThemeLabel, string[]> = {
  人像: [
    'a portrait photograph of a person, the face fills much of the frame',
    'a close-up photo of a human face with visible expression',
  ],
  街拍: [
    'a candid street photograph of pedestrians walking on a city street',
    'documentary street photography captured on a sidewalk',
  ],
  风景: [
    'a landscape photograph of mountains, lakes or open countryside',
    'a wide scenic view of nature with no people in it',
  ],
  花卉: [
    'a close-up photograph of a flower, petals and stamen clearly visible',
    'a photo of blossoms on a plant, botanical photography',
  ],
  建筑: [
    'a photograph of a building facade, showing structural lines',
    'architectural photography of a house, bridge or geometric structure',
  ],
  夜景: [
    'a photograph taken at night, dark sky with artificial lights',
    'a long exposure night scene lit by street lamps and neon',
  ],
  静物: [
    'a still life photograph of objects arranged on a table, no people',
    'a close-up of a single object against a clean plain background',
  ],
  人文: [
    'a documentary photograph of everyday life, people working or at a market',
    'a photo recording ordinary daily life in a local community',
  ],
  微距: [
    'an extreme macro photograph of an insect, water droplet or fine texture',
    'a very close-up shot of tiny details with shallow depth of field',
  ],
  城市: [
    'a cityscape photograph of tall buildings and busy roads',
    'an urban skyline with dense high-rise buildings',
  ],
};

const THEME_GROUPS = THEME_LABELS.map(label => ({ label, prompts: THEME_PROMPTS[label] }));

export function classifyThemes(
  imageVec: number[],
  onProgress?: ClipProgress,
): Promise<LabelScore[]> {
  return scoreGroups(imageVec, THEME_GROUPS, onProgress);
}

const GENERIC_TITLE = /^(DSC|IMG|DCIM|P\d+|PHOTO|image|untitled|微信图片|mmexport)/i;

export function isGenericTitle(title: string): boolean {
  const t = title.replace(/[\s_-]+/g, '');
  return GENERIC_TITLE.test(t);
}

export function titleFromTags(tags: string[], fallback: string): string {
  if (!tags.length) return fallback;
  return tags[0];
}

/** 最高分至少要这么确定，才认为这张图真属于某个主题 */
const TAG_MIN_PROB = 0.3;
/** 次要标签的门槛，同时不能比第一名差太多 */
const EXTRA_MIN_PROB = 0.15;
const EXTRA_RATIO = 0.5;
const TAG_MAX = 3;

/**
 * 拿不准就不打标 —— 空标签只是少一点信息，错标签会让检索和标题一起跑偏。
 */
export function pickTags(scored: LabelScore[]): string[] {
  if (!scored.length) return [];
  const [top, ...rest] = scored;
  if (top.prob < TAG_MIN_PROB) return [];
  const extras = rest
    .filter(s => s.prob >= EXTRA_MIN_PROB && s.prob >= top.prob * EXTRA_RATIO)
    .slice(0, TAG_MAX - 1)
    .map(s => s.label);
  return [top.label, ...extras];
}
