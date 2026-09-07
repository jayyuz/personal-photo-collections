/** Transformers.js v4 设备：优先 WebGPU，CPU 后端内部使用 WASM */
export type HfDevice = 'webgpu' | 'cpu';

export async function pickDevice(): Promise<HfDevice> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (gpu && await gpu.requestAdapter()) return 'webgpu';
  } catch { /* ignore */ }
  return 'cpu';
}

export function dtypeFor(device: HfDevice): 'q4f16' | 'q8' {
  // WebGPU 用 4-bit 权重 + fp16 计算，显著降低首次下载和显存占用。
  return device === 'webgpu' ? 'q4f16' : 'q8';
}
