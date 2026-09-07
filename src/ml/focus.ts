/**
 * 用 DETR 在浏览器里定位主要物体，输出归一化重心给 object-position。
 *
 * Transformers.js 4.x 暂未导出 CLIPSeg 架构，因此这里使用当前版本原生支持的
 * object-detection pipeline；人物优先，其余按置信度和画面占比挑主体。
 */
import type { PhotoFocus } from '../data';
import { mlImageSrc } from './imageSrc';
import { detectorDtype, pickDevice } from './runtime';
import { embedImage, scoreGroups, type ClipProgress } from './clip';

export const FOCUS_MODEL = 'Xenova/detr-resnet-50';

// 提示词用英文，理由同 ml/tagging.ts：MobileCLIP 只认英文
const GOOD = 'good';
const AESTHETIC_GROUPS = [
  {
    label: GOOD,
    prompts: [
      'a well composed professional photograph, sharp and beautifully lit',
      'an award winning photo worth hanging on a wall',
    ],
  },
  {
    label: 'bad',
    prompts: [
      'a blurry out of focus photo, smeared and unusable',
      'a badly exposed cluttered casual snapshot',
    ],
  },
];

interface Detection {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

type Detector = (
  src: string,
  opts: { threshold?: number; percentage?: boolean },
) => Promise<Detection[]>;

let detector: Detector | null = null;
let detectorLoading: Promise<void> | null = null;

async function loadDetector(onProgress?: ClipProgress): Promise<void> {
  if (detector) return;
  if (detectorLoading) return detectorLoading;
  detectorLoading = (async () => {
    onProgress?.('正在加载主体定位模型（首次下载后会缓存）…');
    const { pipeline } = await import('@huggingface/transformers');
    const device = await pickDevice();
    detector = await pipeline('object-detection', FOCUS_MODEL, {
      device,
      dtype: detectorDtype(device),
    }) as Detector;
    onProgress?.(`主体定位模型已就绪（${device}）`);
  })();
  try { await detectorLoading; }
  finally { detectorLoading = null; }
}

function boxScale(box: Detection['box']): number {
  const max = Math.max(box.xmax, box.ymax);
  // percentage=true 在不同 runtime 版本可能返回 0–1 或 0–100。
  return max > 1.01 ? 100 : 1;
}

function importance(d: Detection): number {
  const scale = boxScale(d.box);
  const w = Math.max(0, (d.box.xmax - d.box.xmin) / scale);
  const h = Math.max(0, (d.box.ymax - d.box.ymin) / scale);
  const personBoost = d.label === 'person' ? 1.45 : 1;
  return d.score * personBoost * (0.65 + Math.sqrt(w * h));
}

export async function focusFromImage(src: string, onProgress?: ClipProgress): Promise<PhotoFocus | undefined> {
  await loadDetector(onProgress);
  const detections = await detector!(mlImageSrc(src), {
    threshold: 0.55,
    percentage: true,
  });
  const best = [...detections].sort((a, b) => importance(b) - importance(a))[0];
  if (!best) return { x: 0.5, y: 0.5 };
  const scale = boxScale(best.box);
  return {
    x: Math.min(1, Math.max(0, (best.box.xmin + best.box.xmax) / 2 / scale)),
    y: Math.min(1, Math.max(0, (best.box.ymin + best.box.ymax) / 2 / scale)),
  };
}

/** 用 CLIP 对「好照片 / 废片」二选一，取好照片那一侧的概率，不另下模型 */
export async function aestheticFromImage(src: string, onProgress?: ClipProgress): Promise<number> {
  const img = await embedImage(src, onProgress);
  const scored = await scoreGroups(img, AESTHETIC_GROUPS, onProgress);
  const good = scored.find(s => s.label === GOOD)?.prob ?? 0.5;
  return Math.round(Math.min(1, Math.max(0, good)) * 1e4) / 1e4;
}

export function suggestCoverId(photos: { id: string; aesthetic?: number }[]): string | undefined {
  let best: { id: string; aesthetic: number } | undefined;
  for (const p of photos) {
    if (p.aesthetic == null) continue;
    if (!best || p.aesthetic > best.aesthetic) best = { id: p.id, aesthetic: p.aesthetic };
  }
  return best?.id;
}
