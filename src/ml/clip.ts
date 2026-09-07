/**
 * MobileCLIP S2（Xenova/mobileclip_s2）：图像向量、文本向量、零样本打分。
 *
 * 从 Chinese-CLIP 换过来有两个理由，都和这个站的形态直接相关：
 *   1. Chinese-CLIP 只导出了一张合并的 ONNX，两个塔拆不开。MobileCLIP 是
 *      text_model / vision_model 分开的，谁要用谁加载，不用为了一次打标
 *      把整包权重拉下来。
 *   2. 同量级下零样本准确率高一截，量化掉点也小得多。
 *
 * 代价是它只认英文。主题标签是我们自己定的固定集合，提示词写成英文、界面
 * 照旧显示中文就行；访客那边的自由检索改成本地字段匹配，见 ml/search.ts。
 *
 * 两个容易踩的坑：
 *   1. 模型吐出来的 image_embeds / text_embeds 没有归一化，必须先做 L2，
 *      否则存进 photos.json 的向量和后面算出来的不在一个尺度上。
 *   2. 文本塔的输入长度是固定的 77，tokenizer 要用 padding: 'max_length'，
 *      给 true 只会补到本批最长的那条，形状对不上。
 */
import { compactEmbedding, cosine, mlImageSrc } from './imageSrc';
import { pickDevice, textDtype, VISION_DTYPE } from './runtime';

export const CLIP_MODEL = 'Xenova/mobileclip_s2';

/**
 * 写进 photos.json 的向量都带上这个标记。换模型之后维度可能碰巧还一样，
 * 但已经不在同一个语义空间里 —— 不作废旧向量的话，检索和相似推荐会静默出错，
 * 比报错更难查。
 */
export const EMBED_MODEL = 'mobileclip_s2';

/** CLIP 训练时的 logit 缩放，softmax 要用它才有区分度 */
const LOGIT_SCALE = 100;

/** 文本塔是定长输入，这里不能用 padding: true */
const TEXT_PADDING = 'max_length' as const;

interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
}

type VisionModel = (inputs: Record<string, unknown>) => Promise<{ image_embeds: TensorLike }>;
type TextModel = (inputs: Record<string, unknown>) => Promise<{ text_embeds: TensorLike }>;
type Tokenizer = (
  text: string | string[],
  options?: { padding?: boolean | 'max_length'; truncation?: boolean },
) => Record<string, unknown>;
type Processor = (image: unknown) => Promise<Record<string, unknown>>;

let visionModel: VisionModel | null = null;
let processor: Processor | null = null;
let visionLoading: Promise<void> | null = null;

let textModel: TextModel | null = null;
let tokenizer: Tokenizer | null = null;
let textLoading: Promise<void> | null = null;

const textCache = new Map<string, number[]>();

export type ClipProgress = (msg: string) => void;

export interface LabelScore {
  label: string;
  /** 余弦相似度，-1 ~ 1 */
  score: number;
  /** 在这一组候选里的归一化概率，0 ~ 1 */
  prob: number;
}

function progressCallback(onProgress?: ClipProgress) {
  return (info: { status?: string; file?: string; progress?: number }) => {
    if (info.status === 'progress' && info.file && info.progress != null) {
      onProgress?.(`下载 ${info.file.split('/').pop()} ${Math.round(info.progress)}%`);
    }
  };
}

async function loadVision(onProgress?: ClipProgress): Promise<void> {
  if (visionModel && processor) return;
  if (visionLoading) return visionLoading;
  visionLoading = (async () => {
    onProgress?.('正在加载 MobileCLIP 视觉塔（首次下载后会缓存）…');
    const { AutoProcessor, CLIPVisionModelWithProjection } = await import('@huggingface/transformers');
    const device = await pickDevice();
    const [loadedModel, loadedProcessor] = await Promise.all([
      CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, {
        device,
        dtype: VISION_DTYPE,
        progress_callback: progressCallback(onProgress),
      }),
      AutoProcessor.from_pretrained(CLIP_MODEL),
    ]);
    visionModel = loadedModel as unknown as VisionModel;
    processor = loadedProcessor as unknown as Processor;
    onProgress?.(`视觉塔已就绪（${device}）`);
  })();
  try {
    await visionLoading;
  } finally {
    visionLoading = null;
  }
}

async function loadText(onProgress?: ClipProgress): Promise<void> {
  if (textModel && tokenizer) return;
  if (textLoading) return textLoading;
  textLoading = (async () => {
    onProgress?.('正在加载 MobileCLIP 文本塔（首次下载后会缓存）…');
    const { AutoTokenizer, CLIPTextModelWithProjection } = await import('@huggingface/transformers');
    const device = await pickDevice();
    const [loadedModel, loadedTokenizer] = await Promise.all([
      CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, {
        device,
        dtype: textDtype(device),
        progress_callback: progressCallback(onProgress),
      }),
      AutoTokenizer.from_pretrained(CLIP_MODEL),
    ]);
    textModel = loadedModel as unknown as TextModel;
    tokenizer = loadedTokenizer as unknown as Tokenizer;
    onProgress?.(`文本塔已就绪（${device}）`);
  })();
  try {
    await textLoading;
  } finally {
    textLoading = null;
  }
}

/** 把 [N, D] 或 [D] 的张量拆成若干条单位向量 */
function toRows(out: TensorLike): number[][] {
  const dims = out.dims;
  const d = dims[dims.length - 1];
  const n = dims.length >= 2 ? out.data.length / d : 1;
  const rows: number[][] = [];
  for (let r = 0; r < n; r++) {
    const base = r * d;
    let norm = 0;
    for (let i = 0; i < d; i++) norm += out.data[base + i] * out.data[base + i];
    norm = Math.sqrt(norm) || 1;
    const vec = new Float32Array(d);
    for (let i = 0; i < d; i++) vec[i] = out.data[base + i] / norm;
    rows.push(compactEmbedding(vec));
  }
  return rows;
}

export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map(v => v / norm);
}

/** 一组候选之间的相对概率；单条相似度的绝对值没有意义，只有比较才有 */
export function softmax(scores: number[]): number[] {
  if (!scores.length) return [];
  const logits = scores.map(s => s * LOGIT_SCALE);
  const max = Math.max(...logits);
  const exp = logits.map(l => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0) || 1;
  return exp.map(e => e / sum);
}

export async function embedImage(src: string, onProgress?: ClipProgress): Promise<number[]> {
  await loadVision(onProgress);
  const { RawImage } = await import('@huggingface/transformers');
  const image = await RawImage.read(mlImageSrc(src));
  const inputs = await processor!(image);
  const { image_embeds } = await visionModel!(inputs);
  return toRows(image_embeds)[0];
}

/** 批量求文本向量：提示词是固定的那几十条，算过一次就一直留在缓存里 */
async function embedTexts(texts: string[], onProgress?: ClipProgress): Promise<number[][]> {
  const keys = texts.map(t => t.trim());
  const missing = [...new Set(keys.filter(k => k && !textCache.has(k)))];

  if (missing.length) {
    await loadText(onProgress);
    const run = async (batch: string[]) => {
      const inputs = tokenizer!(batch, { padding: TEXT_PADDING, truncation: true });
      const { text_embeds } = await textModel!(inputs);
      const rows = toRows(text_embeds);
      batch.forEach((k, i) => { if (rows[i]) textCache.set(k, rows[i]); });
    };
    try {
      await run(missing);
    } catch {
      // 个别 ONNX 导出不吃批量文本，退回逐条
      for (const k of missing) await run([k]);
    }
  }

  return keys.map(k => textCache.get(k) ?? []);
}

/**
 * 每个候选可以给多条描述，取它们的平均向量当作这个候选的原型 —— 单个词
 * 在 CLIP 里区分度很差，成句的描述稳得多。
 */
export async function scoreGroups(
  imageVec: number[],
  groups: { label: string; prompts: string[] }[],
  onProgress?: ClipProgress,
): Promise<LabelScore[]> {
  const flat = groups.flatMap(g => g.prompts);
  const vecs = await embedTexts(flat, onProgress);

  const byPrompt = new Map<string, number[]>();
  flat.forEach((p, i) => byPrompt.set(p, vecs[i]));

  const raw = groups.map(g => {
    const rows = g.prompts.map(p => byPrompt.get(p) ?? []).filter(v => v.length);
    if (!rows.length) return { label: g.label, score: 0 };
    const dim = rows[0].length;
    const mean = new Array<number>(dim).fill(0);
    for (const row of rows) {
      for (let i = 0; i < dim; i++) mean[i] += row[i] / rows.length;
    }
    return { label: g.label, score: cosine(imageVec, normalize(mean)) };
  });

  const probs = softmax(raw.map(r => r.score));
  return raw
    .map((r, i) => ({ ...r, prob: probs[i] }))
    .sort((a, b) => b.prob - a.prob);
}

export { cosine };
