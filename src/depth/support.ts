/**
 * WebGL 可用性探测。
 *
 * 有些环境（IDE 内置浏览器、关了硬件加速、某些远程桌面）里 canvas 拿不到
 * WebGL context。与其让用户点进 3D 再看到一句报错，不如提前把入口置灰。
 */
let cached: boolean | null = null;

export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return false;
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') ?? cv.getContext('webgl');
    cached = Boolean(gl);
    // 浏览器同时能开的 context 有上限，探完立刻还回去
    (gl as WebGLRenderingContext | null)
      ?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
