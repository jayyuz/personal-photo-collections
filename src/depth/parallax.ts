/**
 * 3D 视差渲染器（方案 A：细分网格 + 按深度位移顶点）。
 *
 * 原理：把照片贴到一张细分网格上，每个顶点按深度图的「归一化视差」往 Z 方向
 * 推一点；鼠标移动时相机绕画面中心小幅公转，于是近处走得快、远处走得慢 ——
 * 这就是真实的视角变换，不是叠几层做假位移。
 *
 * 网格方案在深度突变处会有一点三角形拉伸（"橡皮片"），但 ±7° 以内基本看不出，
 * 换来的是实现简单、不写 shader、出错也好排查。真要抠细节再换 DIBR 片元着色器。
 */
import * as THREE from 'three';

/** 鼠标推到边缘时的最大视角 */
const MAX_YAW   = THREE.MathUtils.degToRad(7);
const MAX_PITCH = THREE.MathUtils.degToRad(4);
/** 指数平滑时间常数（秒）：太小发抖，太大拖沓 */
const TAU = 0.09;
/** 相机公转会让画面边缘内缩，预留一点放大量把边裁掉 */
const OVERSCAN = 1.09;
const FOV = 32;
/** 网格细分：按画幅长边算，短边同比缩放，保证格子接近正方形 */
const SEG_LONG = 176;

/** photos.json 里存的是相对路径，这里补上站点前缀 */
export function depthUrl(depth: string): string {
  if (/^https?:\/\//.test(depth)) return depth;
  return `${import.meta.env.BASE_URL}${depth.replace(/^\//, '')}`;
}

export interface DepthField {
  width:  number;
  height: number;
  /** 归一化视差，0 = 最远，1 = 最近，行优先 */
  data: Float32Array;
}

/** 读深度图 -> Float32 视差场。顺手做一次 3x3 平滑，减少网格上的台阶 */
export async function loadDepthField(url: string): Promise<DepthField> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload  = () => resolve(im);
    im.onerror = () => reject(new Error(`深度图加载失败：${url}`));
    im.src = url;
  });

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('拿不到 2d context');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  // 深度图是灰度，取 R 通道即可
  const raw = new Float32Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = data[i * 4] / 255;

  return { width: w, height: h, data: blur3(raw, w, h) };
}

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += src[yy * w + xx]; n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** uv -> 视差，双线性采样。深度图第 0 行是画面顶部，uv 的 v=1 才是顶部 */
function sampleDepth(d: DepthField, u: number, v: number): number {
  const x = Math.min(d.width - 1, Math.max(0, u * (d.width  - 1)));
  const y = Math.min(d.height - 1, Math.max(0, (1 - v) * (d.height - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(d.width - 1, x0 + 1);
  const y1 = Math.min(d.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = d.data[y0 * d.width + x0], b = d.data[y0 * d.width + x1];
  const c = d.data[y1 * d.width + x0], e = d.data[y1 * d.width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

export interface ParallaxHandle {
  /** 鼠标在容器里的归一化位置，-1 ~ 1。传 (0,0) 会平滑回正 */
  setPointer(nx: number, ny: number): void;
  /** 视差强度：近处相对画幅高度的位移量，0.05 微妙、0.2 夸张 */
  setAmplitude(a: number): void;
  dispose(): void;
}

export interface ParallaxInit {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  photoUrl: string;
  depth: DepthField;
  /** 真彩色照片要开 sRGB，否则整体发灰 */
  amplitude?: number;
}

export async function createParallax(init: ParallaxInit): Promise<ParallaxHandle> {
  const { canvas, container, photoUrl, depth } = init;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearAlpha(0);

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const tex = await loader.loadAsync(photoUrl);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const img = tex.image as HTMLImageElement;
  const aspect = (img?.naturalWidth || img?.width || 1) / (img?.naturalHeight || img?.height || 1);

  const segX = Math.max(24, Math.round(SEG_LONG * (aspect >= 1 ? 1 : aspect)));
  const segY = Math.max(24, Math.round(SEG_LONG * (aspect >= 1 ? 1 / aspect : 1)));
  const geo  = new THREE.PlaneGeometry(aspect, 1, segX, segY);
  const uvs  = geo.attributes.uv as THREE.BufferAttribute;
  const pos  = geo.attributes.position as THREE.BufferAttribute;

  let amplitude = init.amplitude ?? 0.12;
  const applyAmplitude = (a: number) => {
    for (let i = 0; i < pos.count; i++) {
      const d = sampleDepth(depth, uvs.getX(i), uvs.getY(i));
      pos.setZ(i, (d - 0.5) * a);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
  };
  applyAmplitude(amplitude);

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
  scene.add(mesh);

  /* ---------- 尺寸与适配 ---------- */
  // 平面高度为 1、宽度 aspect；相机距离取「装下高度」和「装下宽度」的较大者，
  // 再除以 OVERSCAN 稍微放大，把公转时内缩的边缘裁掉。
  let dist = 2;
  // dirty 必须声明在 resize 之前：resize() 下面会同步调用一次，
  // 而 ResizeObserver 也是 observe 完立刻回调，放后面就是 TDZ 报错
  let dirty = true;
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const dV  = 0.5 / tan;
    const dH  = (aspect / 2) / (tan * camera.aspect);
    dist = Math.max(dV, dH) / OVERSCAN;
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  /* ---------- 角度跟随 ---------- */
  let targetYaw = 0, targetPitch = 0;
  let yaw = 0, pitch = 0;
  let raf = 0;
  let last = performance.now();
  let disposed = false;

  const frame = (now: number) => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    // 帧率无关的指数平滑
    const k = 1 - Math.exp(-dt / TAU);
    const dy = (targetYaw - yaw) * k;
    const dp = (targetPitch - pitch) * k;
    if (Math.abs(dy) + Math.abs(dp) > 1e-6) {
      yaw += dy; pitch += dp;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;

    const cp = Math.cos(pitch);
    camera.position.set(dist * Math.sin(yaw) * cp, dist * Math.sin(pitch), dist * Math.cos(yaw) * cp);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    setPointer(nx, ny) {
      targetYaw   =  nx * MAX_YAW;
      // 鼠标往上 -> 相机抬高，像把头抬起来看
      targetPitch = -ny * MAX_PITCH;
    },
    setAmplitude(a) {
      amplitude = Math.max(0, Math.min(0.4, a));
      applyAmplitude(amplitude);
      dirty = true;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      geo.dispose();
      (mesh.material as THREE.Material).dispose();
      tex.dispose();
      renderer.dispose();
    },
  };
}
