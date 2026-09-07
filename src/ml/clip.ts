/**
 * Chinese-CLIP：图像向量、文本向量、零样本打分。
 * 权重缓存在浏览器里；Admin 写向量，访客检索只跑文本塔。
 */
import { compactEmbedding, cosine, mlImageSrc } from './imageSrc';
import { dtypeFor, pickDevice } from './runtime';

export const CLIP_MODEL = 'Xenova/chinese-clip-vit-base-patch16';

interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
}

type ClipModel = (inputs: Record<string, unknown>) => Promise<{
  image_embeds: TensorLike;
  text_embeds: TensorLike;
}>;
type Tokenizer = (
  text: string | string[],
  options?: { padding?: boolean; truncation?: boolean },
) => Record<string, unknown>;
type Processor = (image: unknown) => Promise<Record<string, unknown>>;

let model: ClipModel | null = null;
let tokenizer: Tokenizer | null = null;
let processor: Processor | null = null;
let dummyImageInputs: Record<string, unknown> | null = null;
let loading: Promise<void> | null = null;

const textCache = new Map<string, number[]>();

export type ClipProgress = (msg: string) => void;

async function modelOptions(onProgress?: ClipProgress) {
  const device = await pickDevice();
  return {
    device,
    dtype: dtypeFor(device),
    progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
      if (info.status === 'progress' && info.file && info.progress != null) {
        onProgress?.(`下载 ${info.file.split('/').pop()} ${Math.round(info.progress)}%`);
      }
    },
  };
}

async function loadClip(onProgress?: ClipProgress): Promise<void> {
  if (model && tokenizer && processor && dummyImageInputs) return;
  if (loading) return loading;
  loading = (async () => {
    onProgress?.('正在加载 Chinese-CLIP（首次下载后会缓存）…');
    const {
      AutoProcessor,
      AutoTokenizer,
      ChineseCLIPModel,
      RawImage,
    } = await import('@huggingface/transformers');
    const opts = await modelOptions(onProgress);
    const [loadedModel, loadedTokenizer, loadedProcessor] = await Promise.all([
      ChineseCLIPModel.from_pretrained(CLIP_MODEL, opts),
      AutoTokenizer.from_pretrained(CLIP_MODEL),
      AutoProcessor.from_pretrained(CLIP_MODEL),
    ]);
    model = loadedModel as unknown as ClipModel;
    tokenizer = loadedTokenizer as unknown as Tokenizer;
    processor = loadedProcessor as unknown as Processor;
    // Chinese-CLIP 的 ONNX 图同时接收图像和文本；求文本向量时给一张中性占位图。
    const neutral = new RawImage(new Uint8Array(224 * 224 * 3).fill(127), 224, 224, 3);
    dummyImageInputs = await processor(neutral);
    onProgress?.(`Chinese-CLIP 已就绪（${opts.device}）`);
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

function asVector(out: { data: ArrayLike<number>; dims: number[] }): number[] {
  const data = out.data;
  const dims = out.dims;
  // CLIP 投影一般是 [1, 512]；有的模型给出 token 序列，取均值
  if (dims.length === 2) return compactEmbedding(data);
  if (dims.length === 3) {
    const [, tokens, dim] = dims;
    const mean = new Float32Array(dim);
    for (let t = 0; t < tokens; t++) {
      for (let d = 0; d < dim; d++) mean[d] += data[t * dim + d];
    }
    for (let d = 0; d < dim; d++) mean[d] /= tokens;
    return compactEmbedding(mean);
  }
  return compactEmbedding(data);
}

export async function embedImage(src: string, onProgress?: ClipProgress): Promise<number[]> {
  await loadClip(onProgress);
  const { RawImage } = await import('@huggingface/transformers');
  const image = await RawImage.read(mlImageSrc(src));
  const imageInputs = await processor!(image);
  const textInputs = tokenizer!('图片', { padding: true, truncation: true });
  const out = await model!({ ...textInputs, ...imageInputs });
  return asVector(out.image_embeds);
}

export async function embedText(text: string, onProgress?: ClipProgress): Promise<number[]> {
  const key = text.trim();
  const hit = textCache.get(key);
  if (hit) return hit;
  await loadClip(onProgress);
  const textInputs = tokenizer!(key, { padding: true, truncation: true });
  const out = await model!({ ...textInputs, ...dummyImageInputs! });
  const vec = asVector(out.text_embeds);
  textCache.set(key, vec);
  return vec;
}

export async function scoreLabels(
  imageVec: number[],
  labels: readonly string[],
  onProgress?: ClipProgress,
): Promise<{ label: string; score: number }[]> {
  const scored: { label: string; score: number }[] = [];
  for (const label of labels) {
    const t = await embedText(label, onProgress);
    scored.push({ label, score: cosine(imageVec, t) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export { cosine };
