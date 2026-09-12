/**
 * cinema — WebXR 影院模式
 *
 * 观众站在放映厅中央，正前方是一块大银幕；用 Pico 手柄（xr-standard 映射）看片：
 *   摇杆上下  缩放（以射线指向的位置为锚点）
 *   摇杆左右  上一张 / 下一张
 *   扳机按住  按住并移动手柄平移画面
 *   菜单键    打开 / 关闭悬浮照片墙
 *   摇杆按下  复位
 *   长按侧键  退出 VR
 *
 * 缩放不是放大几何体，而是改纹理的 repeat / offset ——
 * 银幕大小恒定，画面在里面放大缩小，才是「在看一张照片」而不是「照片扑面而来」。
 */
import * as THREE from 'three';
import { createPicker, type PickerHandle } from './picker';
import { cloudinaryFit, cloudinaryOriginal, MAX_CLOUDINARY_SIDE } from './source';
import {
  createSettingsPanel, loadSettings, saveSettings,
  type SettingsHandle, type VrSettings,
} from './settings';

export interface VrPhoto {
  src: string;
  title: string;
}

export interface CinemaOptions {
  photos:     VrPhoto[];
  start:      number;
  onIndex?:   (index: number) => void;
  onExit?:    () => void;
  onError?:   (message: string) => void;
}

export interface CinemaHandle {
  stop: () => void;
}

/** 地板平面的高度，以及它在观众这一侧的边缘 z（跟放映厅的地面保持一致） */
const FLOOR_Y       = 0.001;
const FLOOR_NEAR_Z  = 9;      // 地板从 z=-9 开始，见下面的 room / floor

/** 尺寸和手感都放这儿，方便按 Pico 上的实际观感微调（单位：米） */
const CFG = {
  room:      { w: 26, h: 9,  d: 34 },
  // 控制照片的视角大小。太大时头显每度像素不够，照片会明显输给 Pico 浏览器的 2D compositor。
  screen:    { z: -10, y: 3.55, w: 9.6, h: 5.4 },
  photo:     { maxW: 9.0, maxH: 4.9 },
  zoomMax:   6,
  zoomSpeed: 1.5,
  // 关键：信息条必须整个在地板「远端边缘」之上，否则下半截会被地板挡掉。
  // 地板从 z=-9 开始，所以在 z=-8.5 放一条 2.6m 高的条子，下缘必然埋进地里。
  // 解法是把它挪到观众近处（3.5m）：同样的角度只需 1/3 的物理尺寸，
  // 既完全避开地板，每行的像素数反而更多（字更清楚）。像影院字幕一样。
  // 位置说明：地板从 z=-9 开始，它在屏幕上是一条斜线，条子下缘落下去就会被
  // 地板挡掉（之前「照片」「请图」两行就是这么没的）。
  // 所以高度不写死，由下面的自动抬升按几何关系算出来，改画布尺寸也不会再被切。
  hud:       {
    w: 5.6,
    /** 期望高度，自动抬升只会把它往上抬，不会往下压 */
    y: 0.45,
    z: -6,
    tilt: -0.12,
    /** 内容实际画到画布高度的百分之多少（下方留白不算） */
    contentBottom: 0.8,
    /** 抬到地板边缘之上后，再多留的安全余量（米） */
    clearance: 0.1,
  },
  exitHoldMs: 900,
  /** 长按 X 键多久算「打开设置」而不是「上一张」 */
  menuHoldMs: 600,
  /** 设置面板：摆在视线下方，调的时候银幕还看得见 */
  settings:  { width: 1.6, dist: 1.9, dropY: -0.5, tilt: 0.34 },

  /* ---------- 画质 ----------
   * 用户能在 VR 设置面板里改的项都在 settings.ts；这里只放不需要调的常量。 */
  // 拿不到头显原生倍率时的兜底值
  renderScale: 1.4,
  // 眼缓冲中心密度 × panelBoost ≈ 面板密度。只有原生合成层（直接按面板采样）才用得上。
  panelBoost:  1.5,
  // 纹理尺寸量化到 128 的整数倍：既贴近实际占位，又能让 URL 稳定命中 CDN 缓存。
  // 不能用粗档位（1024/1408/…）—— 占位 1000px 却抓 1408px，等于常驻 1.4× 缩小采样，
  // mipmap 一介入就发虚，正好是要避免的那件事。
  granularity: 128,
  // 只有需求比已载入的大 20% 以上才回源，避免摇杆推一下就重下一张
  refetchRatio: 1.2,
  // q_auto 在大屏上压得太狠，明确给高质量
  quality:     88,

  /** 悬浮照片墙 */
  picker: {
    radius:     2.8,   // 幕布离观众的距离
    arcDeg:     100,   // 横向张开的角度，控制在视野内
    thumbWidth: 320,   // 缩略图宽度，够认脸就行，省显存
  },
  // Pico 4 的菜单键在 WebXR Gamepad 里不是标准按钮；多数浏览器暴露在 6/7。
  menuButtons: [6, 7],
};

/**
 * 头显的原生分辨率倍率。规范里先是静态属性、后来改成静态方法，两种都兼容。
 * 拿不到就按 1 处理，交给 renderScale 兜底。
 */
function nativeScaleOf(session: XRSession): number {
  try {
    const layer = XRWebGLLayer as unknown as {
      nativeFramebufferScaleFactor?: number;
      getNativeFramebufferScaleFactor?: (s: XRSession) => number;
    } | undefined;
    // 静态方法在部分运行时没有实现，调用会抛 —— 必须包在 try 里
    const raw = layer?.getNativeFramebufferScaleFactor?.(session)
      ?? layer?.nativeFramebufferScaleFactor;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

/**
 * 开 / 关设置面板的按键。xr-standard 的映射：
 *   0 扳机 · 1 侧键(grip) · 3 摇杆 · 4 A/X · 5 B/Y
 * 用 X(4)：它在 Pico 上必定上报（A/B 翻页一直是好的），
 * 而摇杆按下(3)各家实现差异大，长按经常丢事件。
 * 若 X 在你的设备上也不合适，打开面板看底部「按键」行，
 * 按下你想要的键，把读到的索引填到这里即可。
 */
const MENU_BUTTON = 4;

export async function isVrAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/**
 * Pico 浏览器有时只给 value（模拟量）不给 pressed，或者两者都给得很保守，
 * 所以两种都认。返回 false 就说明这个键压根没上报。
 */
function isDown(b: GamepadButton | undefined): boolean {
  if (!b) return false;
  return b.pressed === true || (typeof b.value === 'number' && b.value > 0.5);
}

/**
 * 摇杆在 xr-standard 里是 axes[2]/[3]，老设备只有触摸板 axes[0]/[1]。
 * 但有些设备（含部分 Pico 机型）并不是这样映射的，所以把实际值暴露出去，
 * 好在头显里直接看出该用哪两个下标。
 */
function stickAxes(gp: Gamepad): { x: number; y: number } {
  const a = gp.axes;
  if (a.length >= 4) return { x: a[2] ?? 0, y: a[3] ?? 0 };
  return { x: a[0] ?? 0, y: a[1] ?? 0 };
}

function pulse(gp: Gamepad, strength: number, ms: number) {
  try {
    void gp.hapticActuators?.[0]?.pulse(strength, ms);
  } catch {
    /* 没有震动就算了 */
  }
}

function shortestDegDelta(next: number, prev: number): number {
  return THREE.MathUtils.euclideanModulo(next - prev + 180, 360) - 180;
}

export async function startCinema(opts: CinemaOptions): Promise<CinemaHandle> {
  const { photos, onIndex, onExit, onError } = opts;
  if (!photos.length) throw new Error('没有可播放的照片');

  const params = new URLSearchParams(window.location.search);
  const numParam = (key: string, min: number, max: number): number | null => {
    const v = Number(params.get(key));
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };

  // 画质参数以设置面板（localStorage）为准；URL 参数仍可临时覆盖，方便对拍。
  const settings: VrSettings = loadSettings();
  const urlScreen = numParam('vrScreen', 0.4, 1.2);
  if (urlScreen !== null) settings.screenScale = urlScreen;
  const urlScale = numParam('vrScale', 0.5, 2);
  if (urlScale !== null) settings.renderScale = urlScale;
  if (params.get('vrLayers') === '0') settings.useLayers = false;

  /*
   * 是否申请 layers feature。
   *
   * 关键：不只是「用不用」，而是**根本别申请**。
   * three 的判断是 `XRWebGLBinding.prototype.createProjectionLayer 存在 &&
   * session.renderState.layers 已被填充`；只要申请过 layers，运行时可能填了
   * renderState.layers 却又没法真正建投影层，于是 three 走进 projection 分支，
   * 内部 getBinding() 拿到 null 就抛 —— 就是那个 "reading getBinding"。
   * 不申请，renderState.layers 保持空，three 就走 XRWebGLLayer 老路，稳。
   * 代价只是用不了原生合成层，而 Pico 本来也不支持。
   */
  const requestLayers = settings.useLayers;
  /** 实际申请成功的特性组合，显示在诊断里，方便定位是哪个特性惹的祸 */
  let sessionFeatures = '';

  /*
   * 还有一个更隐蔽的坑：three 里
   *   const supportsLayers = supportsGlBinding &&
   *     'createProjectionLayer' in XRWebGLBinding.prototype &&
   *     session.renderState.layers !== undefined;
   * 它**不检查 layers 是不是真的申请过**。只要运行时把 renderState.layers
   * 初始化成空数组（有些实现会这么做），three 就走 projection 分支，
   * 内部 getBinding() 拿到 null —— 就是那个 "reading getBinding"。
   * 所以一旦开了「强制缓冲」（自己传 XRWebGLLayer），必须同时申请 layers，
   * 否则 three 会把我们传的层丢掉、再自己去建投影层，然后崩。
   */
  const needLayersFeature = requestLayers || settings.forceWidth > 0;
  // 会话请求失败要能看到原因，否则界面上就是「点了没反应」。
  /*
   * 逐级降级地请求会话。
   * 有些运行时会因为某个 optionalFeature 直接拒绝整个请求（手追尤其常见），
   * 而报错还不一定传到页面。所以从全量开始，失败就逐项往下减，
   * 至少保证能用最基础的 local-floor 进去。
   */
  const allFeatures = [
    ...(needLayersFeature ? ['layers'] : []),
    'hand-tracking',
    'bounded-floor',
    'local-floor',
  ];
  const variants: string[][] = [
    allFeatures,
    allFeatures.filter(f => f !== 'hand-tracking'),
    allFeatures.filter(f => f !== 'hand-tracking' && f !== 'layers'),
    ['local-floor'],
  ];

  let session: XRSession | null = null;
  const attempts: string[] = [];
  for (const features of variants) {
    try {
      session = await navigator.xr!.requestSession('immersive-vr', {
        optionalFeatures: features,
      });
      sessionFeatures = features.join('+') || '(无)';
      break;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}:${e.message}` : String(e);
      attempts.push(`${features.join('+') || '(无)'}→失败(${msg.slice(0, 40)})`);
      console.warn('[vr] requestSession 失败', features, e);
    }
  }
  if (!session) {
    throw new Error(`无法进入 VR：${attempts.join(' | ').slice(0, 200)}`);
  }

  /*
   * 调试时间线。
   * 进了 Pico 的加载页却看不到画面，说明会话建起来了、卡在之后某一步；
   * 而头显里没有控制台，所以把每一步记下来，回到 2D 页面后显示在信息面板里。
   */
  const t0 = performance.now();
  const trace: string[] = [];
  const mark = (s: string) => {
    trace.push(`+${Math.round(performance.now() - t0)}ms ${s}`);
    if (trace.length > 14) trace.shift();
    (window as unknown as { __vrTrace?: string[] }).__vrTrace = trace;
    console.log('[vr]', trace[trace.length - 1]);
  };
  mark(`会话OK(${sessionFeatures})`);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050506);

  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 120);
  camera.position.set(0, 1.6, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  renderer.xr.setFoveation(settings.foveation);

  // 设备到底给不给原生合成层。没申请就一定没给，不必再去碰 renderState.layers。
  const layersAvailable = Boolean(
    requestLayers &&
    session.enabledFeatures?.includes('layers') &&
    typeof XRWebGLBinding !== 'undefined'
  );
  const layersEnabled = layersAvailable && settings.useLayers;

  const nativeScale = nativeScaleOf(session);
  const scaleBase = nativeScale > 1 ? nativeScale : CFG.renderScale;
  // 有原生合成层：照片不经过眼缓冲，按原生渲染就够，多给只是白烧 GPU。
  // 没有合成层：照片要经眼缓冲重采样，而眼缓冲中心密度低于面板，
  // 这时超采样是唯一能真正提清晰度的手段，值得付这份 GPU。
  // 必须在 setSession 之前定下来：base layer 一旦建好，倍率就改不动了
  // —— 所以设置面板里改「超采样」要重进 VR 才生效。
  // 之前上限写死 2.0。实测 Pico 上眼缓冲只有 1440x1584，配合 ~150° 的视锥
  // 只有约 10 px/°（面板应该有 ~20），所以放开上限让用户试更大的超采样。
  const framebufferScale = Math.min(
    4,
    layersEnabled ? scaleBase : scaleBase * settings.renderScale
  );
  renderer.xr.setFramebufferScaleFactor(framebufferScale);
  /** 强制缓冲的结果，显示在诊断里 */
  let forcedNote = settings.forceWidth > 0 ? `请求强制缓冲 ${settings.forceWidth}` : '';

  /*
   * 强制指定眼缓冲尺寸。
   *
   * three 建层时只传 framebufferScaleFactor，不传像素尺寸：
   *   new XRWebGLLayer(session, gl, { framebufferScaleFactor, ... })
   * 而很多运行时会对这个倍率封顶（实测倍率给到 4.0，缓冲仍是 1440x1584），
   * 于是角分辨率被锁死在 ~14 px/°，怎么调都不变清晰。
   * XRWebGLLayer 的构造参数是支持直接指定 framebufferWidth/Height 的，
   * 这里自己建一层传进去，绕开封顶。
   */
  // 说明：framebufferWidth/Height 和 setSession 的第二参数都是规范里有的
  // （MDN 上的 XRWebGLLayer 构造参数），但 TypeScript 内置的 lib.dom 还没跟上，
  // 所以这里做一次类型断言，只在运行时真的支持时才用。
  const LayerCtor = XRWebGLLayer as unknown as
    (new (s: XRSession, gl: WebGLRenderingContext, init: Record<string, unknown>) => XRWebGLLayer)
    | undefined;
  let forcedLayer: XRWebGLLayer | null = null;
  if (settings.forceWidth > 0 && LayerCtor) {
    try {
      const w = settings.forceWidth;
      const h = Math.round(w * 1.1);   // 跟实测到的 1440x1584 同比例
      forcedLayer = new LayerCtor(session, renderer.getContext(), {
        framebufferWidth:  w,
        framebufferHeight: h,
        antialias: false,              // 分辨率上去后就不需要 MSAA 了，省性能
        alpha: true,
      });
      forcedNote = `强制缓冲 ${w}x${h}`;
    } catch (e) {
      forcedLayer = null;
      forcedNote = `强制失败:${String(e).slice(0, 18)}`;
    }
  }

  /** three 的 setSession 支持第二参数（自定义 base layer），但类型声明里没有 */
  const setSession = renderer.xr.setSession as unknown as
    (s: XRSession, layer?: XRWebGLLayer | null) => Promise<void>;

  // local-floor 拿不到就退回 local，至少能进得去。
  // 异常一定要能看到，否则界面上就是「点了 VR 没反应」。
  const startSession = () =>
    forcedLayer ? setSession(session, forcedLayer) : renderer.xr.setSession(session);

  mark(`建层前 forced=${forcedLayer ? 'Y' : 'N'}`);
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
    await startSession();
    // 注意：这里不能调后面才声明的工具函数（TDZ 会直接抛异常），内联取值
    const vp = renderer.xr.getCamera().cameras[0] as
      | (THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }) | undefined;
    mark(`setSession 完成 视口=${Math.round(vp?.viewport?.z ?? 0)}x${Math.round(vp?.viewport?.w ?? 0)}`);
  } catch (e) {
    mark(`setSession 失败:${e instanceof Error ? e.name : '?'}`);
    console.error('[vr] setSession 失败', e);
    try {
      renderer.xr.setReferenceSpaceType('local');
      await startSession();
    } catch (e2) {
      mark(`local 回退也失败:${e2 instanceof Error ? e2.name : '?'}`);
      console.error('[vr] 回退到 local 仍失败', e2);
      const msg = e2 instanceof Error ? `${e2.name}: ${e2.message}` : String(e2);
      throw new Error(`VR 初始化失败（${msg}）`);
    }
  }
  mark('场景开始搭建');

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const maxTexSize = renderer.capabilities.maxTextureSize || 4096;
  const maxSourceSide = Math.min(maxTexSize, MAX_CLOUDINARY_SIDE);
  /** 量化到 128 的整数倍，贴近实际占位又能稳定命中 CDN 缓存 */
  const quantize = (want: number): number => {
    const g = CFG.granularity;
    const v = Math.ceil(Math.max(512, want) / g) * g;
    return Math.min(maxSourceSide, v);
  };
  /**
   * 取图。默认走「原图」：直接拿 CDN 上的原始分辨率，
   * 不依赖任何测量结果 —— 之前按测量尺寸算，在部分设备上量出 512px，
   * 拿去填上千像素的位置，糊就是这么来的。
   */
  const vrSource = (src: string, size: number) => {
    const mode = settings.sourceMode;
    lastAsk = mode === 'auto' ? Math.min(size, maxSourceSide) : mode;
    if (mode === 'original') return cloudinaryOriginal(src, CFG.quality);
    if (mode === 'auto') {
      return cloudinaryFit(src, Math.min(size, maxSourceSide), CFG.quality, settings.sharpen);
    }
    // 固定长边
    return cloudinaryFit(src, Math.min(mode, maxSourceSide), CFG.quality, settings.sharpen);
  };

  /* ---------- 放映厅 ---------- */
  // 放映厅几乎铺满整个视野，用 PBR（MeshStandardMaterial）画等于按原生分辨率
  // 跑一遍全屏 PBR，Pico 这一档 GPU 很容易掉帧；Lambert 便宜得多，观感差别极小。
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(CFG.room.w, CFG.room.h, CFG.room.d),
    new THREE.MeshLambertMaterial({ color: 0x121216, side: THREE.BackSide })
  );
  room.position.set(0, CFG.room.h / 2, -CFG.room.d / 2 + 8);
  scene.add(room);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.room.w, CFG.room.d),
    new THREE.MeshLambertMaterial({ color: 0x141210 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001, -CFG.room.d / 2 + 8);
  scene.add(floor);

  // 座椅只做空间参照，不需要精准
  const seatMat  = new THREE.MeshLambertMaterial({ color: 0x1b1b1e });
  const seatGeom = new THREE.BoxGeometry(0.55, 0.9, 0.6);
  for (let row = 0; row < 3; row++) {
    for (let col = -4; col <= 4; col++) {
      const seat = new THREE.Mesh(seatGeom, seatMat);
      seat.position.set(col * 1.05, 0.45, 2.4 + row * 1.6);
      scene.add(seat);
    }
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  // 银幕的溢光：厅里由近及远变暗，又不至于全黑到失去空间感
  const glow = new THREE.PointLight(0xbfd4ff, 50, 45, 1.2);
  glow.position.set(0, CFG.screen.y, CFG.screen.z + 3);
  scene.add(glow);

  /* ---------- 银幕 ----------
   * 全部用 1×1 平面 + scale：银幕大小要能在设置面板里实时改。 */
  const unitQuad = new THREE.PlaneGeometry(1, 1);

  const frame = new THREE.Mesh(unitQuad, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  frame.position.set(0, CFG.screen.y, CFG.screen.z - 0.05);
  scene.add(frame);

  const border = new THREE.Mesh(unitQuad, new THREE.MeshBasicMaterial({ color: 0x1a1a1d }));
  border.position.set(0, CFG.screen.y, CFG.screen.z - 0.08);
  scene.add(border);

  const photoMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const photo = new THREE.Mesh(unitQuad, photoMat);
  photo.position.set(0, CFG.screen.y, CFG.screen.z);
  scene.add(photo);

  /* ---------- 银幕下方的信息条 ----------
   * 内容：标题 / 提示 / 诊断（含取图链路排查行）。
   * 「设置」按钮是独立物体（见下），不挂在这个组里。
   *
   * 位置很讲究，踩过两个坑：
   *   1) 画布不够高 → 最后几行被画到画布外，等于没画
   *   2) 条子下缘落到地板平面以下 → 被地板挡掉，之前「照片」「请图」两行就是这么没的
   * 所以现在把条子放到观众近处（3.5m）：同样的视角只需 1/3 的物理尺寸，
   * 既完全避开地板，每行的像素数还更多，字更清楚。像影院字幕。
   */
  const hudCanvas  = document.createElement('canvas');
  hudCanvas.width  = 2048;
  // 3 行大字 + 7 行诊断：高度按内容算，别再让最后几行画到画布外面
  hudCanvas.height = 680;
  const hudCtx     = hudCanvas.getContext('2d')!;
  const hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;

  const hudGroup = new THREE.Group();
  // 高度按画布宽高比推导，改画布尺寸时不用再手动同步
  const hudW = CFG.hud.w;
  const hudH = hudW * (hudCanvas.height / hudCanvas.width);
  hudGroup.rotation.x = CFG.hud.tilt;

  /*
   * 自动抬到地板边缘之上。
   *
   * 地板是一张从 z=FLOOR_NEAR_Z 开始的水平面。它在屏幕上是一条斜线：
   * 视线要「越过」这条边才看得到更远的东西。信息条虽然整体在地板前方
   * （z 更小），但只要你站得比它高，条子下缘在屏幕上就可能落在这条线
   * 下面 —— 那就被地板挡掉了。之前「照片」「请图」两行就是这么消失的。
   *
   * 判据（眼高 1.6m）：内容下缘的屏幕纵坐标必须高于地板边缘的屏幕纵坐标。
   * 展开后就是： y_bottom > (eyeY - 0.001) * |z| / FLOOR_NEAR_Z - eyeY
   */
  {
    const eyeY = camera.position.y;
    // 内容下缘允许的最低世界 y（低于它就会被地板挡住）
    const limit = (eyeY - FLOOR_Y) * Math.abs(CFG.hud.z) / Math.abs(FLOOR_NEAR_Z) - eyeY;
    // 内容下缘相对信息条中心的局部偏移（含 tilt 造成的下沉）
    const drop = hudH * (CFG.hud.contentBottom - 0.5)
      + Math.sin(CFG.hud.tilt) * Math.abs(CFG.hud.z) * 0.5;
    hudGroup.position.set(0, Math.max(CFG.hud.y, limit + drop + CFG.hud.clearance), CFG.hud.z);
  }
  scene.add(hudGroup);

  /** 圆角矩形路径，信息条与按钮共用 */
  const roundRectPath = (
    c: CanvasRenderingContext2D, w: number, h: number, r: number
  ) => {
    const rr = Math.min(r, h / 2, w / 2);
    c.beginPath();
    c.moveTo(rr, 0);
    c.arcTo(w, 0, w, h, rr);
    c.arcTo(w, h, 0, h, rr);
    c.arcTo(0, h, 0, 0, rr);
    c.arcTo(0, 0, w, 0, rr);
    c.closePath();
  };
  /*
   * depthTest: false —— 信息条永远画在最上层。
   * 之前一直有半截被挡，反复调高度也没用，因为挡它的东西不是我猜的那个；
   * 与其继续猜场景里是谁在挡，不如直接让它不参与深度比较 ——
   * 它本来就是 UI，压在场景之上是合理的。
   */
  const hud  = new THREE.Mesh(
    new THREE.PlaneGeometry(hudW, hudH),
    new THREE.MeshBasicMaterial({
      map: hudTexture, transparent: true, depthWrite: false, depthTest: false,
    })
  );
  hud.renderOrder = 1000;
  hudGroup.add(hud);

  /* 「设置」按钮
   * 两个要点：
   * 1) 不放进 hudGroup —— 挂在信息条下面会落到地板平面以下，被地板挡住。
   * 2) 放到观众近处（2.5m 外）而不是银幕那边。
   *    同样看清的前提下，越近需要的物理尺寸越小、占的像素越少 —— 反过来
   *    就是同样尺寸能给出更大的视角和更多像素。0.7m @ 2.5m ≈ 16°，
   *    比 1.4m @ 9m 的 8.9° 清楚得多（字高从 ~24 涨到 ~40 物理像素）。
   */
  const btnCanvas  = document.createElement('canvas');
  btnCanvas.width  = 512;
  btnCanvas.height = 128;
  const btnCtx     = btnCanvas.getContext('2d')!;
  const btnTexture = new THREE.CanvasTexture(btnCanvas);
  btnTexture.colorSpace = THREE.SRGBColorSpace;
  const btnW  = 0.7;
  const btnH  = btnW * (btnCanvas.height / btnCanvas.width);
  // 同样不参与深度比较，并且排在信息条之后，保证按钮压在最上面
  const btnMat = new THREE.MeshBasicMaterial({
    map: btnTexture, transparent: true, depthWrite: false, depthTest: false,
  });
  const hudButton = new THREE.Mesh(new THREE.PlaneGeometry(btnW, btnH), btnMat);
  hudButton.renderOrder = 1001;
  // 右手边、略低于视线：低头一点就能看到，又不挡银幕。
  // z 要比信息条更靠前，免得被信息条挡住
  hudButton.position.set(0.95, 1.15, -2.0);
  hudButton.rotation.x = -0.25;
  hudButton.rotation.y = -0.35;
  scene.add(hudButton);

  let btnHover = false;
  const drawHudButton = () => {
    const w = btnCanvas.width;
    const h = btnCanvas.height;
    btnCtx.clearRect(0, 0, w, h);
    roundRectPath(btnCtx, w, h, 30);
    btnCtx.fillStyle = `rgba(10,10,14,${btnHover ? 0.9 : 0.55})`;
    btnCtx.fill();
    if (btnHover) {
      btnCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      btnCtx.lineWidth = 4;
      btnCtx.stroke();
    }
    // 扳手图标
    btnCtx.strokeStyle = btnHover ? '#fff' : 'rgba(240,240,240,0.85)';
    btnCtx.lineWidth = 9;
    btnCtx.lineCap = 'round';
    btnCtx.beginPath();
    btnCtx.arc(58, 64, 20, Math.PI * 0.75, Math.PI * 2.1);
    btnCtx.stroke();
    btnCtx.beginPath();
    btnCtx.moveTo(72, 50);
    btnCtx.lineTo(104, 82);
    btnCtx.stroke();
    btnCtx.textAlign = 'left';
    btnCtx.fillStyle = btnHover ? '#fff' : 'rgba(240,240,240,0.9)';
    btnCtx.font = '500 54px system-ui, -apple-system, sans-serif';
    btnCtx.fillText('设置', 128, 88);
    btnTexture.needsUpdate = true;
  };
  drawHudButton();

  mark('放映厅+银幕就绪');

  /* ---------- 手柄 ---------- */
  const rayGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
  ]);
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    const line = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({
      color: 0x9fb4ff, transparent: true, opacity: 0.45,
    }));
    line.scale.z = 6;
    c.add(line);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.045, 0.13),
      new THREE.MeshBasicMaterial({ color: 0x2a2a2f })
    ));
    scene.add(c, grip);
  }

  /* ---------- 播放状态 ---------- */
  let index = Math.min(Math.max(opts.start, 0), photos.length - 1);
  let zoom  = 1;
  let offX  = 0;
  let offY  = 0;
  let texture: THREE.Texture | null = null;
  let disposed = false;

  /**
   * 直接测量：把宽 w 米的物体投影到屏幕上，量它实际占多少像素。
   *
   * 早先是用「投影矩阵 p[0] × 视口宽 / 2」推算的，但在部分设备上会取到错的
   * 视口（比如只拿到纹理数组的一小块），算出来的占位小了好几倍 ——
   * 于是只向 CDN 要了几百像素的图，糊是必然的。
   * 这里改成把两端的世界坐标真的投影一遍，数出来是多少就是多少。
   * 必须在 renderer.render 之后调用，那时相机矩阵才是当帧的。
   */
  const measureFootprintPx = (w: number): number => {
    const eye = renderer.xr.getCamera().cameras[0] as
      | (THREE.PerspectiveCamera & { viewport?: THREE.Vector4 })
      | undefined;
    const vpW = effectiveEyeWidth() || (eye?.viewport?.z ?? 0);
    if (!(vpW > 0)) return 0;
    // 银幕平面与视线垂直，取它左右两端投影后的水平像素差即可
    const a = new THREE.Vector3(-w / 2, CFG.screen.y, CFG.screen.z).project(eye!);
    const b = new THREE.Vector3(w / 2, CFG.screen.y, CFG.screen.z).project(eye!);
    return Math.abs((b.x - a.x) * vpW / 2);
  };

  /**
   * 独立再测一遍角分辨率（像素 / 度），用来交叉验证下面的密度。
   *
   * 不碰投影矩阵，纯几何：在银幕左右各取一点，用点积算它们相对眼睛的真实
   * 夹角，再除投影后的像素差。之前靠「投影矩阵 p[0] × 视口宽 / 2」推算，
   * 在部分设备上视口取错，结果差了 5 倍 —— 于是只下了一张几百像素的图。
   */
  const measurePxPerDeg = (): number => {
    const eye = renderer.xr.getCamera().cameras[0] as
      | (THREE.PerspectiveCamera & { viewport?: THREE.Vector4 })
      | undefined;
    const vpW = effectiveEyeWidth() || (eye?.viewport?.z ?? 0);
    if (!(vpW > 0) || !eye) return 0;
    const wp = new THREE.Vector3();
    eye.getWorldPosition(wp);
    const half = 2;   // 半宽 2m，夹角够大才量得准
    const L = new THREE.Vector3(-half, CFG.screen.y, CFG.screen.z);
    const R = new THREE.Vector3( half, CFG.screen.y, CFG.screen.z);
    const angDeg = THREE.MathUtils.radToDeg(
      L.clone().sub(wp).angleTo(R.clone().sub(wp))
    );
    if (!(angDeg > 0.1)) return 0;
    const a = L.clone().project(eye);
    const b = R.clone().project(eye);
    const px = Math.abs((b.x - a.x) * vpW / 2);
    return px / angDeg;
  };

  /** 原始测量值，纯排查用：眼宽 / 屏幕占位数 / 采样计数 / 拒收计数 */
  const dbg = { eyeW: 0, px: 0, n: 0, rej: 0 };

  /** 采一次密度样本，攒够一批就定稿（取中位数，抗异常值） */
  const sampleDensity = () => {
    if (measuredPxPerMeter) return;
    dbg.eyeW = effectiveEyeWidth();
    dbg.px = Math.round(measureFootprintPx(CFG.photo.maxW));
    const d = dbg.px / CFG.photo.maxW;
    if (!(d > 20 && d < 4000)) { dbg.rej++; return; }
    /*
     * 只在正视时采信，否则透视拉伸会把结果压小。
     * 基准不能拿首帧的一次性测量值 —— 那一帧头可能没转过来，量出 5.0 的话
     * 真实值（~155）反而会被当成异常值全拒收，采样永远是 0。
     * 改用「视口宽 / 视场角」推算的参考密度，这个和头的朝向无关。
     */
    const fov = horizontalFov();
    const eyeW = dbg.eyeW;
    const nominal = (fov > 5 && eyeW > 0) ? (eyeW / fov) : 0;
    if (densitySamples.length < 5 || !nominal ||
        Math.abs(d - nominal) < nominal * 0.4) {
      densitySamples.push(d);
      if (d > densityMax) densityMax = d;
    } else {
      dbg.rej++;
    }
    dbg.n = densitySamples.length;
    if (densitySamples.length >= 24) {
      const s = [...densitySamples].sort((a, b) => a - b);
      measuredPxPerMeter = s[Math.floor(s.length / 2)];
      loadedStep = 0;          // 之前按错尺寸下的图换掉
      bumpDiagnostics();
    }
  };

  /** 独立测得的角分辨率（px/°）；0 = 还没量到 */
  let measuredPxPerDeg = 0;
  /** 手柄摇杆轴的原始值，用来确认 Pico 的实际映射（左右/上下分别是哪个） */
  let axesDump = '';

  /*
   * 密度采样。
   *
   * 教训：一次性测量不可靠。测量那一帧如果头没正对银幕，照片会偏到视野边缘，
   * 而透视投影在边缘是拉伸的，横向像素差会被压扁 —— 实测就出现过 104° 视锥
   * 却量出 5.0 px/°（应为 ~14）的情况，而且这个值被永久缓存，导致纹理尺寸
   * 一路算错。
   *
   * 所以改成：每次测量都算出「照片相对眼睛的真实夹角」，只在这个夹角接近
   * 正视预期值时才采信（说明头正对着银幕），攒够一批取中位数。
   */
  const densitySamples: number[] = [];
  let densityMax = 0;

  /**
   * 实测得到的「每米多少像素」（按 1 倍银幕、照片正好铺满时的宽度算）。
   * 存成密度而不是绝对像素，这样切换银幕大小时不用重量。
   */
  let measuredPxPerMeter = 0;

  /**
   * 角分辨率（像素 / 弧度）—— 整件事的核心。
   *
   * 银幕张开约 48°，头显每度只有固定像素，所以银幕能用的像素数是有上限的，
   * 再大的纹理也变不出像素来。纹理尺寸必须**贴着实际采样率**取：
   *   取小了 → 放大插值，糊；
   *   取大了 → 缩小采样，摩尔纹。
   * 上一版就是错在这里：纹理按「面板密度」取，而 3D Plane 实际是在
   * 「眼缓冲密度」上被采样的，两者差 1.5 倍，等于持续 1.5× 缩小采样 → 摩尔纹。
   *
   * 所以这里区分两个密度：
   *   eye   — 投影矩阵实测，3D Plane 路径的真实采样率
   *   panel — eye × panelBoost，原生合成层直接按面板采样时才用
   */
  let eyePxPerRad = 0;
  const measureEyePxPerRad = (): number => {
    if (eyePxPerRad) return eyePxPerRad;
    const eye = renderer.xr.getCamera().cameras[0] as
      | (THREE.PerspectiveCamera & { viewport?: THREE.Vector4 })
      | undefined;
    const vpW = eye?.viewport?.z ?? 0;
    // p[0] = 2n/(r-l)，中心处 d(NDC)/d(角度)；再乘半个视口宽换成像素
    const p0 = eye?.projectionMatrix.elements[0] ?? 0;
    if (!(vpW > 0) || !(p0 > 0)) return 0;
    eyePxPerRad = p0 * vpW / 2;
    return eyePxPerRad;
  };

  /** 银幕张开的水平弧度 */
  const screenRad = (w: number) => 2 * Math.atan(w / 2 / Math.abs(CFG.screen.z));

  /** 当前照片的宽高比，改银幕大小时要靠它重算 */
  let photoAspect = 3 / 2;

  /**
   * 按 settings.screenScale 重排银幕。
   * 银幕变小 → 占位变小 → 需要的纹理也变小，调用方记得触发一次重取，
   * 否则会留着一张过大的纹理常驻缩小采样（= 摩尔纹）。
   */
  const relayoutScreen = () => {
    const s = settings.screenScale;
    frame.scale.set(CFG.screen.w * s + 0.5, CFG.screen.h * s + 0.5, 1);
    border.scale.set(CFG.screen.w * s + 0.9, CFG.screen.h * s + 0.9, 1);

    let w = CFG.photo.maxW * s;
    let h = w / photoAspect;
    const maxH = CFG.photo.maxH * s;
    if (h > maxH) { h = maxH; w = h * photoAspect; }
    photo.scale.set(w, h, 1);
    if (photoLayerImage) syncPhotoLayer(photoLayerImage, w, h);
  };

  /**
   * 宽 w 米的画面横跨多少像素。
   * forPanel=true 用于原生合成层（按面板密度），否则按眼缓冲实测密度。
   */
  const footprintPx = (w: number, forPanel = false): number => {
    // 有实测密度就用它（原生合成层按面板采样，密度比眼缓冲高 panelBoost 倍）
    if (measuredPxPerMeter > 0) {
      return Math.round(w * measuredPxPerMeter * (forPanel ? CFG.panelBoost : 1));
    }
    // 还没量到时的兜底，量到后会自动修正
    const pxPerRad = measureEyePxPerRad() * (forPanel ? CFG.panelBoost : 1);
    return pxPerRad > 0 ? Math.round(screenRad(w) * pxPerRad) : 1600;
  };

  type PhotoLayerPainter = {
    fb: WebGLFramebuffer;
    tex: WebGLTexture;
    program: WebGLProgram;
    pos: WebGLBuffer;
    uv: WebGLBuffer;
    aPos: number;
    aUv: number;
    uTex: WebGLUniformLocation | null;
    uUv: WebGLUniformLocation | null;
  };

  const gl = renderer.getContext();
  let photoLayer: XRQuadLayer | null = null;
  let photoLayerInState = false;
  let photoLayerPixels = { w: 0, h: 0 };
  let photoLayerImage: TexImageSource | null = null;
  let photoLayerImageDirty = false;
  let photoLayerDirty = false;
  let layerPainter: PhotoLayerPainter | null = null;
  /*
   * 取 XRWebGLBinding。没有 layers 支持时它是 null —— 之前直接拿去用，
   * `binding.getSubImage(...)` 当场抛 "Cannot read properties of null"，
   * 整个 VR 会话起不来。所以一律走这个安全包装。
   */
  const getBindingSafe = (): XRWebGLBinding | null => {
    if (!layersAvailable || !settings.useLayers) return null;
    try {
      return renderer.xr.getBinding() ?? null;
    } catch {
      return null;
    }
  };

  let layersUsable = Boolean(
    layersEnabled && getBindingSafe() && session.renderState.layers?.length
  );
  let layerStatus = !layersAvailable
    ? '设备/浏览器未提供 WebXR Layers，已按 3D Plane 路径优化'
    : !settings.useLayers
      ? '已在设置里关闭原生合成层'
      : layersUsable
        ? '等待创建 XRQuadLayer'
        : 'renderState.layers 不可用，走 3D Plane';
  let sourcePixels = { w: 0, h: 0 };
  let diagnosticsVersion = 0;
  /**
   * 照片墙 / 设置面板是否打开。
   * 合成层不参与深度测试，会盖穿这些面板，所以它们开着时必须压住合成层
   * —— 包括后台换图完成时的自动重挂。
   */
  let overlayOpen = false;
  /** 平滑后的帧时长，用来看有没有掉帧（掉帧会触发重投影，整幅画面拖影） */
  let frameMs = 0;
  /** 最后一次的取图参数：数字是长边像素，'original' 表示取原图 */
  let lastAsk: number | string = 0;

  /** 手柄上报了几个键：-1 还没读到手柄，0 说明浏览器根本没给按键 */
  let btnCount = -1;
  /** 最近一次按下的键号（数组下标），用来一项一项对出按键映射 */
  let lastBtn = -1;

  const bumpDiagnostics = () => { diagnosticsVersion++; };

  const sizeText = (s: { w: number; h: number }) => s.w > 0 && s.h > 0 ? `${s.w}x${s.h}` : 'n/a';
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e || '未知错误');

  const xrEye = () => renderer.xr.getCamera().cameras[0] as
    | (THREE.PerspectiveCamera & { viewport?: THREE.Vector4 })
    | undefined;

  /** 投影矩阵给出的水平视场角（度） */
  const horizontalFov = (): number => {
    const p = xrEye()?.projectionMatrix.elements;
    if (!p || !(p[0] > 0)) return 0;
    return THREE.MathUtils.radToDeg(2 * Math.atan(1 / p[0]));
  };

  /*
   * 单眼真正分到多少像素宽。
   *
   * 只有确属「一张纹理里横向并排多个视口」时才做折算：判据是存在 x > 0 的
   * 视口 —— 那才是并排的证据。
   * 若所有视口的 x 都是 0（说明是纹理数组 / 每眼一张独立纹理），
   * 就直接取 viewport.z。之前按「眼的个数」折算过，实测 x0 眼2 的情况下
   * 把 1440 误算成 720，密度直接腰斩，纹理也跟着取小了一半。
   */
  const effectiveEyeWidth = (): number => {
    const cams = renderer.xr.getCamera().cameras as
      ((THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }) | undefined)[];
    const vs = cams
      .map(c => c?.viewport)
      .filter((v): v is THREE.Vector4 => Boolean(v && v.z > 0));
    if (!vs.length) return 0;
    const raw = vs[0]!.z;
    const xs = new Set(vs.map(v => Math.round(v.x)));
    const packed = [...xs].filter(x => x > 0).length + 1;   // x>0 的都算并排
    return Math.round(raw / packed);
  };

  /** 实际分配到的眼缓冲尺寸（单眼）。运行时可能不理会我们请求的倍率，看这个才准 */
  const eyeBufferText = (): string => {
    const cam = xrEye();
    const w = cam?.viewport?.z ?? 0;
    const h = cam?.viewport?.w ?? 0;
    return w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : 'n/a';
  };

  const diagnosticLines = () => {
    const forPanel = Boolean(photoLayer && photoLayerInState);
    const foot = footprintPx(photo.scale.x, forPanel);
    // 采样比 = 纹理像素 / 实际需要的像素。>1 缩小采样（摩尔纹），<1 插值（发虚）
    const ratio = foot > 0 && sourcePixels.w > 0
      ? (sourcePixels.w / (foot * zoom)).toFixed(2)
      : 'n/a';
    return [
      `缓冲 ${eyeBufferText()} 实宽${effectiveEyeWidth() || '-'} ${forcedNote}`,
      `特性 ${sessionFeatures}`,
      `摇杆 ${axesDump || '—'}`,
      `视锥 ${horizontalFov().toFixed(0)}° 缓冲${eyeBufferText()}`,
      `倍率 ${framebufferScale.toFixed(2)}(原生${nativeScale.toFixed(2)})`,
      `密度 ${measuredPxPerMeter ? measuredPxPerMeter.toFixed(0) : '量中'}px/m 占位 ${foot}px`,
      `源图 ${sizeText(sourcePixels)} 请图 ${lastAsk} 比 ${ratio}`,
      `照片 ${photo.scale.x.toFixed(2)}m 比 ${photoAspect.toFixed(2)} zoom ${zoom.toFixed(1)}`,
      `路径 ${(photoLayer && photoLayerInState ? 'QuadLayer' : '3D Plane').slice(0, 10)} ${layerStatus.slice(0, 26)}`,
      `银幕${settings.screenScale} 余量${settings.superSample} 锐化${settings.sharpen} mip${settings.mipmaps ? '开' : '关'} ${photoLayer && photoLayerInState ? 'Quad' : 'Plane'} 键${lastBtn < 0 ? '-' : lastBtn}/${btnCount}`,
    ];
  };

  const compile = (type: GLenum, src: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('无法创建 WebGL shader');
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(shader) || 'WebGL shader 编译失败';
      gl.deleteShader(shader);
      throw new Error(msg);
    }
    return shader;
  };

  const ensureLayerPainter = (): PhotoLayerPainter => {
    if (layerPainter) return layerPainter;
    const vs = compile(gl.VERTEX_SHADER, `
      precision highp float;
      attribute vec2 aPos;
      attribute vec2 aUv;
      varying highp vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `);
    const fs = compile(gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      uniform highp vec4 uUv;
      void main() {
        gl_FragColor = texture2D(uTex, uUv.xy + vUv * uUv.zw);
      }
    `);
    const program = gl.createProgram();
    if (!program) throw new Error('无法创建 WebGL program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const msg = gl.getProgramInfoLog(program) || 'WebGL program 链接失败';
      gl.deleteProgram(program);
      throw new Error(msg);
    }

    const pos = gl.createBuffer();
    const uv = gl.createBuffer();
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!pos || !uv || !tex || !fb) throw new Error('无法创建 WebXR layer 绘制资源');

    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    layerPainter = {
      fb, tex, program, pos, uv,
      aPos: gl.getAttribLocation(program, 'aPos'),
      aUv: gl.getAttribLocation(program, 'aUv'),
      uTex: gl.getUniformLocation(program, 'uTex'),
      uUv: gl.getUniformLocation(program, 'uUv'),
    };
    return layerPainter;
  };

  const setPhotoLayerInRenderState = (visible: boolean) => {
    // 有面板开着就一律不挂，等面板关了再说
    if (visible && overlayOpen) return;
    if (!photoLayer || !session.renderState.layers || photoLayerInState === visible) return;
    const layers = session.renderState.layers.filter(layer => layer !== photoLayer);
    // renderState.layers 是「由后往前」的顺序：数组末尾才是最上层。
    // 放在开头会被 three 的 projection layer（不透明背景）整块盖掉。
    void session.updateRenderState({ layers: visible ? [...layers, photoLayer] : layers }).catch(e => {
      layersUsable = false;
      photoLayerInState = false;
      layerStatus = `updateRenderState 失败: ${errorText(e)}`;
      photo.visible = true;
      bumpDiagnostics();
      drawHud();
    });
    photoLayerInState = visible;
    layerStatus = visible ? 'layer 已加入 renderState.layers' : '照片墙打开，主图 layer 暂时隐藏';
    // 合成层生效时就别再画 3D 平面了：既省填充率，也避免两者半透明叠加互相污染
    photo.visible = !visible;
    photoLayerDirty = visible || photoLayerDirty;
    bumpDiagnostics();
  };

  const destroyPhotoLayer = () => {
    if (!photoLayer) return;
    setPhotoLayerInRenderState(false);
    photoLayer.destroy();
    photoLayer = null;
    photoLayerPixels = { w: 0, h: 0 };
  };

  const syncPhotoLayer = (image: TexImageSource, w: number, h: number) => {
    if (!layersUsable) return;
    const space = renderer.xr.getReferenceSpace();
    if (!space) {
      layerStatus = '没有 XR referenceSpace，暂用 3D Plane';
      bumpDiagnostics();
      return;
    }
    try {
      // 合成层的分辨率要贴着「面板上实际占多少像素」，不能照源图尺寸开。
      // 开太大：合成层没有 mipmap，缩小采样会闪；还会白占显存、每次重传更慢。
      // 开太小：直接糊。
      const pixelW = Math.max(
        512,
        Math.min(maxTexSize, Math.round(footprintPx(w, true) * settings.superSample))
      );
      const pixelH = Math.max(1, Math.min(maxTexSize, Math.round(pixelW * (h / w))));
      const binding = getBindingSafe();
      if (!binding?.createQuadLayer) {
        layersUsable = false;
        layerStatus = 'XRWebGLBinding 不支持 createQuadLayer，暂用 3D Plane';
        bumpDiagnostics();
        return;
      }
      if (!photoLayer || photoLayerPixels.w !== pixelW || photoLayerPixels.h !== pixelH) {
        destroyPhotoLayer();
        photoLayer = binding.createQuadLayer({
          space,
          transform: new XRRigidTransform(
            { x: 0, y: CFG.screen.y, z: CFG.screen.z },
            { x: 0, y: 0, z: 0, w: 1 }
          ),
          width: w / 2,
          height: h / 2,
          viewPixelWidth: pixelW,
          viewPixelHeight: pixelH,
          layout: 'mono',
          isStatic: false,
        });
        photoLayer.chromaticAberrationCorrection = true;
        photoLayer.blendTextureSourceAlpha = false;
        photoLayerPixels = { w: pixelW, h: pixelH };
        layerStatus = '已创建原生 XRQuadLayer';
      } else {
        // XRQuadLayer 的 width/height 是「半宽 / 半高」
        photoLayer.width = w / 2;
        photoLayer.height = h / 2;
        photoLayer.transform = new XRRigidTransform(
          { x: 0, y: CFG.screen.y, z: CFG.screen.z },
          { x: 0, y: 0, z: 0, w: 1 }
        );
      }
      photoLayerImage = image;
      photoLayerImageDirty = true;
      photoLayerDirty = true;
      setPhotoLayerInRenderState(true);
      bumpDiagnostics();
    } catch (e) {
      layersUsable = false;
      destroyPhotoLayer();
      layerStatus = `XRQuadLayer 创建失败: ${errorText(e)}`;
      bumpDiagnostics();
    }
  };

  const paintPhotoLayer = (frame: XRFrame) => {
    if (!photoLayer || !photoLayerImage || !photoLayerInState) return;
    if (!photoLayerDirty && !photoLayer.needsRedraw) return;
    try {
      const binding = getBindingSafe();
      if (!binding) {
        layersUsable = false;
        destroyPhotoLayer();
        return;
      }
      const sub = binding.getSubImage(photoLayer, frame);
      const p = ensureLayerPainter();

      // 源图只在换图时上传一次。之前每帧重传，4096² RGBA 一次 64MB，
      // 缩放 / 拖动时必然掉帧，重投影一介入画面就更糊了。
      if (photoLayerImageDirty) {
        gl.bindTexture(gl.TEXTURE_2D, p.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, photoLayerImage);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        photoLayerImageDirty = false;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, p.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sub.colorTexture, 0);
      gl.viewport(sub.viewport.x, sub.viewport.y, sub.viewport.width, sub.viewport.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(p.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.pos);
      gl.enableVertexAttribArray(p.aPos);
      gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.uv);
      gl.enableVertexAttribArray(p.aUv);
      gl.vertexAttribPointer(p.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.uniform1i(p.uTex, 0);
      gl.uniform4f(p.uUv, offX, offY, 1 / zoom, 1 / zoom);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // 我们绕过 three 直接动了 GL 状态，必须让 three 重新同步自己的缓存
      renderer.resetState();
      photoLayerDirty = false;
      layerStatus = 'layer 已绘制当前照片';
      bumpDiagnostics();
      drawHud();
    } catch (e) {
      layersUsable = false;
      destroyPhotoLayer();
      layerStatus = `XRQuadLayer 绘制失败: ${errorText(e)}`;
      bumpDiagnostics();
      drawHud();
    }
  };

  const clampOffset = (x: number, y: number) => {
    const r = 1 / zoom;
    return {
      x: Math.min(1 - r, Math.max(0, x)),
      y: Math.min(1 - r, Math.max(0, y)),
    };
  };

  const apply = () => {
    if (!texture) return;
    const r = 1 / zoom;
    const o = clampOffset(offX, offY);
    offX = o.x;
    offY = o.y;
    texture.repeat.set(r, r);
    texture.offset.set(offX, offY);
    photoLayerDirty = true;
  };

  // 缩放时每帧都重画 canvas 太费，内容没变就跳过
  let hudKey = '';
  const drawHud = (note?: string) => {
    const key = `${index}|${Math.round(zoom * 100)}|${diagnosticsVersion}|${Math.round(frameMs)}|${note ?? ''}`;
    if (key === hudKey) return;
    hudKey = key;
    const w = hudCanvas.width;
    hudCtx.clearRect(0, 0, w, hudCanvas.height);
    // 半透明底：银幕溢光在这块深底上才能看清字
    roundRectPath(hudCtx, w, hudCanvas.height, 30);
    hudCtx.fillStyle = 'rgba(10,10,14,0.42)';
    hudCtx.fill();

    hudCtx.textAlign = 'center';
    hudCtx.fillStyle = 'rgba(255,255,255,0.95)';
    hudCtx.font = '700 72px system-ui, -apple-system, sans-serif';
    hudCtx.fillText(`${index + 1} / ${photos.length}　${photos[index].title}`, w / 2, 78);
    hudCtx.fillStyle = 'rgba(255,255,255,0.62)';
    hudCtx.font = '600 56px system-ui, -apple-system, sans-serif';
    const tip = note
      ?? (zoom > 1.01
        ? `已放大 ${Math.round(zoom * 100)}% · 扳机拖动 · 指向右边「设置」扣扳机可调画质`
        : '摇杆上下 缩放 · 左右 翻页 · 扳机按住 拖动 · 指向右边「设置」扣扳机可调画质');
    hudCtx.fillText(tip, w / 2, 150);

    if (settings.diagnostics) {
      hudCtx.textAlign = 'left';
      hudCtx.font = '700 62px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      hudCtx.fillStyle = photoLayer && photoLayerInState
        ? 'rgba(145,255,180,0.95)'
        : 'rgba(255,204,128,0.95)';
      const lines = diagnosticLines();
      // 行距 64px。等宽字体每个字符约 0.6em = 36px，一行最多约 54 个字符，
      // 诊断内容要按这个长度裁剪，否则右侧会被画到画布外。
      for (let i = 0; i < lines.length; i++) {
        hudCtx.fillText(lines[i].slice(0, 52), 48, 248 + i * 64);
      }
    }
    hudTexture.needsUpdate = true;
  };

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  // 切图自增，异步回调靠它判断自己是不是过期了
  let token = 0;
  /** 当前纹理是按哪个档位下载的；0 = 还没有 */
  let loadedStep = 0;
  /** 正在下载的档位；0 = 空闲 */
  let loadingStep = 0;

  const prepare = (tex: THREE.Texture) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    // mipmap 正常都该开着。纹理已经按实际采样率取，LOD≈0、mipmap 基本不参与，
    // 不损失细节；但视角一斜、头一动、或刚好差一点点缩小采样时，
    // 它是唯一能挡住摩尔纹的东西。设置面板里可以关掉，用来确认摩尔纹来源。
    tex.generateMipmaps = settings.mipmaps;
    tex.minFilter  = settings.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };

  /**
   * 当前缩放下需要多少像素的源图。
   *
   * 按眼缓冲实测密度取（3D Plane 就是在这个密度上被采样的）。
   * 走原生合成层时改按面板密度，因为那条路不经过眼缓冲。
   */
  const wantedStep = (): number => {
    const forPanel = Boolean(photoLayer && photoLayerInState);
    return quantize(footprintPx(photo.scale.x, forPanel) * zoom * settings.superSample);
  };

  const adoptTexture = (tex: THREE.Texture, step: number) => {
    texture?.dispose();
    texture = prepare(tex);
    loadedStep = Math.max(loadedStep, step);

    const img = tex.image as { width?: number; height?: number };
    sourcePixels = { w: Math.round(img.width || 0), h: Math.round(img.height || 0) };
    bumpDiagnostics();

    photoAspect = img?.width && img?.height ? img.width / img.height : 3 / 2;
    photoMat.map = tex;
    photoMat.color.set(picker.isOpen() ? 0x2b2b2b : 0xffffff);
    photoMat.needsUpdate = true;
    photoLayerImage = tex.image as TexImageSource;
    // 尺寸、合成层同步都在这里面做
    relayoutScreen();
    photo.visible = !(photoLayer && photoLayerInState);
    apply();
  };

  /**
   * 按档位取图。
   * isSwitch = true 表示这是换照片（必须换上），否则只是缩放后要更高分辨率。
   */
  const loadStep = (step: number, isSwitch: boolean) => {
    const my = token;
    loadingStep = step;
    loader.load(
      vrSource(photos[index].src, step),
      tex => {
        loadingStep = 0;
        if (disposed || my !== token) { tex.dispose(); return; }
        const cur = texture?.image as { width?: number } | undefined;
        const next = tex.image as { width?: number };
        // Cloudinary 不会把图放大到超过原图；换来的不比现在这张大就别换，
        // 同时把 loadedStep 抬上去，免得每帧都重复请求同一张。
        if (!isSwitch && cur?.width && next?.width && next.width <= cur.width) {
          loadedStep = Math.max(loadedStep, step);
          bumpDiagnostics();
          tex.dispose();
          return;
        }
        adoptTexture(tex, step);
        drawHud();
        if (isSwitch) {
          picker.setPlaying(index);
          onIndex?.(index);
        }
      },
      undefined,
      () => {
        loadingStep = 0;
        // 失败的档位也记下来，否则主循环会每帧重试
        loadedStep = Math.max(loadedStep, step);
        if (disposed || my !== token) return;
        if (isSwitch) {
          drawHud('这张图载入失败，摇杆左右换一张');
          onError?.(`VR 里载入失败：${photos[index].title}`);
        }
      }
    );
  };

  const showPhoto = (i: number) => {
    index = (i + photos.length) % photos.length;
    zoom = 1; offX = 0; offY = 0;
    loadedStep = 0;
    token++;
    drawHud('载入中…');
    loadStep(wantedStep(), true);
  };

  /** 合成层按当前占位应该开多大 */
  const wantedLayerPx = () =>
    Math.max(512, Math.min(maxTexSize, Math.round(footprintPx(photo.scale.x, true) * settings.superSample)));

  /** 缩放到需要更多像素时，后台换一张更大的；换完保持当前的缩放和平移 */
  const refineSource = () => {
    // 面板密度要到第一帧才量得到，量到之后按真实占位把合成层重开一次
    if (
      photoLayer && photoLayerImage && layersUsable && !picker.isOpen() &&
      photoLayerPixels.w !== wantedLayerPx()
    ) {
      syncPhotoLayer(photoLayerImage, photo.scale.x, photo.scale.y);
    }
    if (loadingStep) return;
    const want = wantedStep();
    // 加迟滞：只有明显不够（20% 以上）才回源，否则摇杆一动就重下一张
    if (want > loadedStep * CFG.refetchRatio || (!loadedStep && want > 0)) {
      loadStep(want, false);
    }
  };

  /** 以画面上的某点为锚点缩放：锚点下的像素保持不动 */
  const zoomAt = (factor: number, u?: number, v?: number) => {
    const next = Math.min(CFG.zoomMax, Math.max(1, zoom * factor));
    if (Math.abs(next - zoom) < 1e-4) return;
    const au = u ?? 0.5;
    const av = v ?? 0.5;
    const tu = offX + au / zoom;
    const tv = offY + av / zoom;
    zoom = next;
    offX = tu - au / zoom;
    offY = tv - av / zoom;
    if (zoom === 1) { offX = 0; offY = 0; }
    apply();
    drawHud();
  };

  const reset = () => {
    zoom = 1; offX = 0; offY = 0;
    apply();
    drawHud();
  };

  /* ---------- 悬浮照片墙 ---------- */
  const picker: PickerHandle = createPicker({
    photos,
    radius:     CFG.picker.radius,
    arcDeg:     CFG.picker.arcDeg,
    eyeY:       1.6,
    thumbWidth: CFG.picker.thumbWidth,
    quality:    CFG.quality,
    anisotropy: maxAniso,
  });
  picker.group.visible = false;
  scene.add(picker.group);

  const headPos = new THREE.Vector3();
  const headDir = new THREE.Vector3();

  const placePickerInFrontOfHead = () => {
    const xrCamera = renderer.xr.getCamera();
    xrCamera.updateMatrixWorld();
    xrCamera.getWorldPosition(headPos);
    xrCamera.getWorldDirection(headDir);
    headDir.y = 0;
    if (headDir.lengthSq() < 1e-4) headDir.set(0, 0, -1);
    else headDir.normalize();

    // picker 内部按「眼高 1.6m」排布；这里用头显实际高度修正，使顶行始终接近视线。
    picker.group.position.set(headPos.x, headPos.y - 1.6, headPos.z);
    picker.group.rotation.y = Math.atan2(-headDir.x, -headDir.z);
    picker.invalidate();
  };

  const togglePicker = () => {
    const next = !picker.isOpen();
    if (next) placePickerInFrontOfHead();
    picker.setOpen(next);
    overlayOpen = next;
    // 照片墙打开时压暗银幕，免得和缩略图抢注意力
    photoMat.color.set(next ? 0x2b2b2b : texture ? 0xffffff : 0x111111);
    setPhotoLayerInRenderState(!next);
    photo.visible = !(photoLayer && photoLayerInState);
    hud.visible = !next;
    // 「设置」按钮不能跟着主信息条一起藏：面板开着时它还要用来关闭
    drawHud();
  };

  /* ---------- 画质设置面板 ---------- */
  const settingsPanel: SettingsHandle = createSettingsPanel({
    settings,
    width: CFG.settings.width,
    dist:  CFG.settings.dist,
    dropY: CFG.settings.dropY,
    tilt:  CFG.settings.tilt,
    layersAvailable,
  });
  scene.add(settingsPanel.group);

  /** 按 settings.useLayers 决定挂不挂原生合成层 */
  const applyLayerPreference = () => {
    const want = layersAvailable && settings.useLayers;
    if (!want) {
      destroyPhotoLayer();
      layersUsable = false;
      layerStatus = layersAvailable
        ? '已在设置里关闭原生合成层'
        : '设备/浏览器未提供 WebXR Layers，已按 3D Plane 路径优化';
      photo.visible = true;
    } else if (!layersUsable) {
      layersUsable = Boolean(session.renderState.layers);
      layerStatus = layersUsable ? '重新启用原生合成层' : 'renderState.layers 不可用，走 3D Plane';
      if (layersUsable && photoLayerImage) {
        syncPhotoLayer(photoLayerImage, photo.scale.x, photo.scale.y);
      }
    }
    bumpDiagnostics();
  };

  /**
   * 把设置应用到运行中的场景。
   * refetch=true 表示这次改动影响了「该下多大的图」，要重新取一张。
   */
  const applySettings = (refetch: boolean) => {
    saveSettings(settings);
    renderer.xr.setFoveation(settings.foveation);
    if (texture) prepare(texture);
    applyLayerPreference();
    relayoutScreen();
    // loadedStep 清零 → 主循环里的 refineSource 会按新参数重新评估该取多大
    if (refetch) loadedStep = 0;
    bumpDiagnostics();
    drawHud();
  };

  /** 改了这些就得重下图：要么影响 URL，要么影响该下多大 */
  const NEEDS_REFETCH: ReadonlySet<string> = new Set([
    'screenScale', 'superSample', 'sharpen', 'useLayers', 'sourceMode', 'reset',
  ]);

  const toggleSettings = () => {
    const next = !settingsPanel.isOpen();
    if (next) {
      if (picker.isOpen()) togglePicker();
      const xrCamera = renderer.xr.getCamera();
      xrCamera.updateMatrixWorld();
      xrCamera.getWorldPosition(headPos);
      xrCamera.getWorldDirection(headDir);
      headDir.y = 0;
      if (headDir.lengthSq() < 1e-4) headDir.set(0, 0, -1);
      else headDir.normalize();
      settingsPanel.placeInFrontOf(headPos, headDir);
      settingsPanel.invalidate();
    }
    settingsPanel.setOpen(next);
    overlayOpen = next;

    // 原生合成层是「贴」在最上层的，不参与深度测试，会直接盖穿面板。
    // 菜单打开期间退回 3D Plane，遮挡关系才正常（关掉菜单就恢复）。
    setPhotoLayerInRenderState(!next);
    photo.visible = !(photoLayer && photoLayerInState);
    // 银幕下方的 HUD 正好被面板挡住，诊断信息改在面板底部显示
    hud.visible = !next;
    drawHud();
  };

  /** 面板底部那行实时状态，短到能塞进一行 */
  const statusLine = (): string => {
    const forPanel = Boolean(photoLayer && photoLayerInState);
    const foot = footprintPx(photo.scale.x, forPanel);
    const ratio = foot > 0 && sourcePixels.w > 0
      ? (sourcePixels.w / (foot * zoom)).toFixed(2)
      : '—';
    // btnCount：手柄上报了几个键。-1 没读到手柄，0 说明浏览器压根没给按键
    const gp = btnCount < 0 ? '' : ` · 键${btnCount}`;
    return `采样比 ${ratio} 最佳1.0 · 占位 ${foot}px · 源图 ${sourcePixels.w || '—'} · 眼缓冲 ${eyeBufferText()} · ${frameMs.toFixed(1)}ms${gp}`;
  };

  const pick = (i: number) => {
    showPhoto(i);
    togglePicker();
  };

  /* ---------- 射线拾取：手柄指向银幕上的哪一点 ---------- */
  const raycaster = new THREE.Raycaster();
  const tmpMat = new THREE.Matrix4();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();

  let lastYaw = 0;   // 手柄朝向的水平角（度），拖动画布时用它算位移

  /** 把射线摆到手柄指向上；顺手记下朝向角 */
  const aim = (src: XRInputSource, frame: XRFrame): boolean => {
    const space = renderer.xr.getReferenceSpace();
    if (!space || !src.targetRaySpace) return false;
    const pose = frame.getPose(src.targetRaySpace, space);
    if (!pose) return false;
    tmpMat.fromArray(pose.transform.matrix);
    origin.setFromMatrixPosition(tmpMat);
    // 方向向量只吃旋转，不能用 applyMatrix4（会把平移也算进去）
    dir.set(0, 0, -1).transformDirection(tmpMat);
    lastYaw = THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z));
    raycaster.set(origin, dir);
    return true;
  };

  const screenUv = (src: XRInputSource, frame: XRFrame): THREE.Vector2 | null => {
    if (!aim(src, frame)) return null;
    const hit = raycaster.intersectObject(photo, false)[0];
    return hit?.uv ? hit.uv.clone() : null;
  };

  /**
   * 射线是否指在 HUD 的「设置」按钮上。
   * 这是打开设置的保底入口 —— 不依赖手柄上报任何按键，
   * 只要扳机能用（拖动画面一直在用，肯定是好的）就能进设置。
   */
  const hudButtonHit = (src: XRInputSource, frame: XRFrame): boolean => {
    if (!hudButton.visible || !aim(src, frame)) return false;
    return raycaster.intersectObject(hudButton, false).length > 0;
  };

  /* ---------- 手柄状态 ---------- */
  interface CtrlState {
    prev:  boolean[];
    latch: boolean;
    gripAt: number | null;
    /**
     * X 键按下的起始时刻。
     * null = 没按, >0 = 按下时刻, -1 = 长按已触发, -2 = 松手已处理
     */
    menuAt: number | null;
    drag:   { u: number; v: number } | null;
    /** 照片墙：拖动时的起始朝向与累计角度 */
    dragYaw:   number | null;
    dragMoved: number;
    latchX: boolean;
    latchY: boolean;
  }
  const states = new Map<XRInputSource, CtrlState>();
  const stateOf = (src: XRInputSource): CtrlState => {
    let s = states.get(src);
    if (!s) {
      s = {
        prev: [], latch: false, gripAt: null, menuAt: null, drag: null,
        dragYaw: null, dragMoved: 0, latchX: false, latchY: false,
      };
      states.set(src, s);
    }
    return s;
  };

  let last = performance.now();

  const readInput = (frame: XRFrame, now: number, dt: number) => {
    const pickerOpen = picker.isOpen();
    let hovered = false;
    let hoveredSettings = false;

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const st = stateOf(src);
      const { x: ax, y: ay } = stickAxes(gp as Gamepad);
      const btn = gp.buttons;
      axesDump = `n${gp.axes.length} [${[...gp.axes].slice(0, 4).map(v => v.toFixed(1)).join(' ')}] 用(${ax.toFixed(1)},${ay.toFixed(1)})`;
      const trigger = isDown(btn[0]);
      // 手柄到底报了几个键；0 就说明浏览器根本没给按键
      btnCount = btn.length;
      // 记下新按下的键号：不管它在哪一帧、也不管当前是哪个界面
      for (let i = 0; i < btn.length; i++) {
        if (isDown(btn[i]) && !st.prev[i] && i !== 0) lastBtn = i;
      }

      // X 键（xr-standard button 4）长按 = 开 / 关设置面板；短按仍是上一张。
      // 摇杆按下（3）在各家实现里差异太大，别再拿它做长按。
      // st.menuAt: null = 没按, >0 = 按下时刻, -1 = 长按已触发，按住不放不再重复
      const menuBtn = isDown(btn[MENU_BUTTON]);
      if (menuBtn) {
        if (st.menuAt === null) {
          st.menuAt = now;
        } else if (st.menuAt > 0 && now - st.menuAt > CFG.menuHoldMs) {
          st.menuAt = -1;
          pulse(gp as Gamepad, 0.8, 60);
          toggleSettings();
          st.prev = btn.map(b => b.pressed);
          continue;
        }
      } else if (st.menuAt !== null) {
        // 松手时才判定短按：整个按下期间没到长按阈值，才算「点了一下」。
        // 在按下沿就翻页的话，长按开菜单时会顺带翻走一张。
        if (st.menuAt > 0) showPhoto(index - 1);
        st.menuAt = -2;   // 已处理过这次松手，别再触发
      }

      // 摇杆按下：复位（短按即可，不再兼做长按）
      if (isDown(btn[3]) && !st.prev[3]) {
        reset();
        pulse(gp as Gamepad, 0.4, 30);
      }

      // 设置面板打开时，手柄只用来点选项。
      // 这里必须读实时值：上面刚可能被另一只手柄（或本帧的长按）切过
      if (settingsPanel.isOpen()) {
        if (aim(src, frame)) {
          if (settingsPanel.hover(raycaster)) hoveredSettings = true;
          if (trigger && !st.prev[0]) {
            const changed = settingsPanel.click(raycaster);
            if (changed) {
              pulse(gp as Gamepad, 0.6, 40);
              applySettings(NEEDS_REFETCH.has(changed));
              settingsPanel.setStatus(statusLine());
              settingsPanel.invalidate();
            }
          }
        }
        // 侧键 / 菜单键：关掉面板；长按侧键仍然退出 VR
        const gripS = isDown(btn[1]);
        if (gripS && st.gripAt === null) st.gripAt = now;
        if (!gripS && st.gripAt !== null) {
          if (now - st.gripAt < CFG.exitHoldMs) toggleSettings();
          st.gripAt = null;
        }
        if (gripS && st.gripAt !== null && now - st.gripAt > CFG.exitHoldMs) {
          pulse(gp as Gamepad, 1, 120);
          void session.end();
          return;
        }
        for (const b of CFG.menuButtons) {
          if (isDown(btn[b]) && !st.prev[b]) toggleSettings();
        }
        st.prev = btn.map(isDown);
        continue;
      }

      // Pico 4 菜单键不是 xr-standard 的固定按钮，常见实现会放在 6/7。
      for (const b of CFG.menuButtons) {
        if (isDown(btn[b]) && !st.prev[b]) togglePicker();
      }

      // 侧键：短按开关照片墙，长按退出 VR
      const grip = isDown(btn[1]);
      if (grip && st.gripAt === null) st.gripAt = now;
      if (!grip && st.gripAt !== null) {
        if (now - st.gripAt < CFG.exitHoldMs) togglePicker();
        st.gripAt = null;
      }
      if (grip && st.gripAt !== null && now - st.gripAt > CFG.exitHoldMs) {
        pulse(gp as Gamepad, 1, 120);
        void session.end();
        return;
      }

      if (pickerOpen) {
        // 「设置」按钮仍然可用，不用先退出照片墙
        if (trigger && !st.prev[0] && hudButtonHit(src, frame)) {
          pulse(gp as Gamepad, 0.6, 40);
          toggleSettings();
          st.prev = btn.map(isDown);
          continue;
        }
        // 悬停高亮
        if (aim(src, frame)) {
          const hit = picker.hitIndex(raycaster);
          if (hit !== null) { picker.setHover(hit); hovered = true; }
        }

        // 按住扳机左右拖动：整块幕布跟着手转
        if (trigger) {
          if (st.dragYaw === null) { st.dragYaw = lastYaw; st.dragMoved = 0; }
          else {
            const d = shortestDegDelta(lastYaw, st.dragYaw);
            st.dragYaw = lastYaw;
            st.dragMoved += Math.abs(d);
            picker.dragBy(-d / picker.columnStepDeg());
          }
        } else if (st.dragYaw !== null) {
          // 基本没挪动就是点选
          if (st.dragMoved < 5 && aim(src, frame)) {
            const hit = picker.hitIndex(raycaster);
            if (hit !== null) { pulse(gp as Gamepad, 0.7, 45); pick(hit); }
          } else {
            picker.releaseDrag();
          }
          st.dragYaw = null;
        }

        // 摇杆：上下换疏密，左右整列翻页
        if (Math.abs(ay) > 0.6 && !st.latchY) {
          st.latchY = true;
          picker.zoomBy(ay < 0 ? -1 : 1);
          pulse(gp as Gamepad, 0.4, 30);
        } else if (Math.abs(ay) < 0.3) st.latchY = false;

        if (Math.abs(ax) > 0.65 && !st.latchX) {
          st.latchX = true;
          picker.pageBy((ax < 0 ? -1 : 1) * picker.pageStepColumns());
          pulse(gp as Gamepad, 0.4, 30);
        } else if (Math.abs(ax) < 0.35) st.latchX = false;

        st.prev = btn.map(isDown);
        continue;
      }

      // 指向「设置」按钮扣扳机 —— 打开设置的主要入口
      if (trigger && !st.prev[0] && hudButtonHit(src, frame)) {
        pulse(gp as Gamepad, 0.6, 40);
        toggleSettings();
        st.prev = btn.map(isDown);
        continue;
      }

      // 按钮悬停高亮
      const overBtn = hudButtonHit(src, frame);
      if (overBtn !== btnHover) { btnHover = overBtn; drawHudButton(); }

      // 缩放：摇杆上下，锚点取射线指向处
      if (Math.abs(ay) > 0.15) {
        const uv = screenUv(src, frame);
        zoomAt(Math.exp(-ay * CFG.zoomSpeed * dt), uv?.x, uv?.y);
      }

      // 翻页：摇杆左右，推一下只翻一张
      if (Math.abs(ax) > 0.65 && !st.latch) {
        st.latch = true;
        pulse(gp as Gamepad, 0.6, 45);
        showPhoto(index + (ax < 0 ? -1 : 1));
      } else if (Math.abs(ax) < 0.35) {
        st.latch = false;
      }

      // 扳机按住：拖动画面
      if (trigger) {
        const uv = screenUv(src, frame);
        if (uv) {
          if (!st.drag) st.drag = { u: offX + uv.x / zoom, v: offY + uv.y / zoom };
          offX = st.drag.u - uv.x / zoom;
          offY = st.drag.v - uv.y / zoom;
          apply();
        }
      } else {
        st.drag = null;
      }

      // B（5）下一张。A（4）的短按上一张在上面松手时判定
      if (isDown(btn[5]) && !st.prev[5]) showPhoto(index + 1);

      st.prev = btn.map(isDown);
    }

    if (pickerOpen && !hovered) picker.setHover(null);
    if (settingsPanel.isOpen()) {
      if (!hoveredSettings) settingsPanel.clearHover();
      settingsPanel.setStatus(statusLine());
    }
  };

  /* ---------- 主循环 ---------- */
  let hudTick = 0;
  // 第一张图要等第一帧：只有进了帧才量得到眼缓冲密度，
  // 否则会先按兜底值下载一张尺寸不对的，然后要么发虚要么白下一次。
  let firstShowDone = false;
  renderer.setAnimationLoop((_time, frame) => {
    if (!frame) return;
    try {
    const now = performance.now();
    const dt  = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    // 指数平滑，用来在 HUD 上看有没有掉帧
    frameMs = frameMs ? frameMs + (dt * 1000 - frameMs) * 0.05 : dt * 1000;

    if (!firstShowDone) mark('首帧');
    if (!firstShowDone && measureEyePxPerRad() > 0) {
      firstShowDone = true;
      mark('首帧取图');
      showPhoto(index);
    }

    readInput(frame, now, dt);
    picker.update(dt);
    settingsPanel.update(dt);
    paintPhotoLayer(frame);
    // 缩放后按需换更大的源图，让银幕始终接近 1:1 采样
    if (firstShowDone) refineSource();
    // 每秒刷一次诊断（帧时、采样比会持续变化）
    if (now - hudTick > 1000) {
      hudTick = now;
      if (settingsPanel.isOpen()) settingsPanel.setStatus(statusLine());
      else drawHud();
    }
    renderer.render(scene, camera);

    // 渲染之后相机矩阵才是当帧的，这时量才准
    sampleDensity();
    if (!measuredPxPerDeg) {
      const d = measurePxPerDeg();
      if (d > 3 && d < 200) { measuredPxPerDeg = d; bumpDiagnostics(); }
    }
    } catch (e) {
      // 主循环里的异常会让画面永远停在加载页，必须留痕
      mark(`循环异常:${e instanceof Error ? e.name : '?'}`);
      console.error('[vr] 主循环异常', e);
      renderer.setAnimationLoop(null);
    }
  });

  /* ---------- 收尾 ---------- */
  let stopped = false;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    disposed = true;
    renderer.setAnimationLoop(null);
    scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach(m => m.dispose());
      else mat?.dispose();
    });
    picker.dispose();
    settingsPanel.dispose();
    destroyPhotoLayer();
    if (layerPainter) {
      gl.deleteFramebuffer(layerPainter.fb);
      gl.deleteTexture(layerPainter.tex);
      gl.deleteProgram(layerPainter.program);
      gl.deleteBuffer(layerPainter.pos);
      gl.deleteBuffer(layerPainter.uv);
      layerPainter = null;
    }
    rayGeom.dispose();
    texture?.dispose();
    hudTexture.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };

  session.addEventListener('end', () => {
    dispose();
    onExit?.();
  });

  mark('主循环已启动');

  drawHud('载入中…');

  return {
    stop: () => {
      dispose();
      void session.end().catch(() => {});
    },
  };
}
