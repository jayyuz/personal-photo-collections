/**
 * 浏览器里 Transformers.js 只认 webgpu 和 wasm 这两个设备名 —— 'cpu' 是
 * Node 端的叫法，传进来会直接抛 Unsupported device。
 */
export type HfDevice = 'webgpu' | 'wasm';

export async function pickDevice(): Promise<HfDevice> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (gpu && await gpu.requestAdapter()) return 'webgpu';
  } catch { /* ignore */ }
  return 'wasm';
}

/**
 * MobileCLIP 的视觉塔是重参数化卷积，量化后掉点明显，模型仓库的
 * transformers.js_config 也把它钉在 fp32。这一塔只在 Admin 侧跑，
 * 权重进浏览器缓存后就不再下载，多花 143 MB 换准确率是划算的。
 */
export const VISION_DTYPE = 'fp32';

/** 文本塔是普通 Transformer，量化耐受度高，按设备取能跑的最高精度 */
export function textDtype(device: HfDevice): 'fp16' | 'q8' {
  return device === 'webgpu' ? 'fp16' : 'q8';
}

/** DETR 只要主体框的位置，不参与语义比较，精度要求最低 */
export function detectorDtype(device: HfDevice): 'fp16' | 'q8' {
  return device === 'webgpu' ? 'fp16' : 'q8';
}
