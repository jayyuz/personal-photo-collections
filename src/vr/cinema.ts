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
import { cloudinaryFit, MAX_CLOUDINARY_SIDE } from './source';

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

/** 尺寸和手感都放这儿，方便按 Pico 上的实际观感微调（单位：米） */
const CFG = {
  room:      { w: 26, h: 9,  d: 34 },
  // 控制照片的视角大小。太大时头显每度像素不够，照片会明显输给 Pico 浏览器的 2D compositor。
  screen:    { z: -10, y: 3.55, w: 9.6, h: 5.4 },
  photo:     { maxW: 9.0, maxH: 4.9 },
  zoomMax:   6,
  zoomSpeed: 1.5,
  hud:       { w: 7.2, y: 0.15, z: -9.4, tilt: -0.12 },
  exitHoldMs: 900,

  /* ---------- 画质 ---------- */
  // three 默认 foveation = 1（边缘低分辨率），银幕铺满视野时正好糊在边缘上，关掉
  foveation:   0,
  // 没有原生合成层时，眼缓冲就是画质瓶颈：它是一张覆盖 ~105° 的透视贴图，
  // 中心角分辨率只有面板的 ~1/panelBoost。把渲染倍率往上顶，把中心密度提到面板水平。
  eyeBoost:    1.35,
  // 拿不到头显原生倍率时的兜底值
  renderScale: 1.4,
  // 眼缓冲中心密度 × panelBoost ≈ 面板密度。只有原生合成层（直接按面板采样）才用得上。
  panelBoost:  1.5,
  // 纹理比实际采样率略大一点，避免正好卡在 1:1 边界上；
  // 注意别调大：超过 1 的部分就是缩小采样，正是摩尔纹的来源。
  superSample: 1.06,
  // 纹理尺寸量化到 128 的整数倍：既贴近实际占位，又能让 URL 稳定命中 CDN 缓存。
  // 不能用粗档位（1024/1408/…）—— 占位 1000px 却抓 1408px，等于常驻 1.4× 缩小采样，
  // mipmap 一介入就发虚，正好是要避免的那件事。
  granularity: 128,
  // 只有需求比已载入的大 20% 以上才回源，避免摇杆推一下就重下一张
  refetchRatio: 1.2,
  // q_auto 在大屏上压得太狠，明确给高质量
  quality:     88,
  // 服务端下采样后补一点锐度。这个值不能大：锐化会把能量堆到 Nyquist 附近，
  // 一旦有任何缩小采样就直接变成摩尔纹。
  sharpen:     25,

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
    };
    const raw = layer.getNativeFramebufferScaleFactor?.(session)
      ?? layer.nativeFramebufferScaleFactor;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

export async function isVrAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/** 摇杆在 xr-standard 里是 axes[2]/[3]，老设备只有触摸板 axes[0]/[1] */
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

  const tryNativeLayers = params.get('vrLayers') !== '0';
  // 银幕的视角大小是清晰度最直接的杠杆：缩小 = 同样的像素铺更小的角度 = 更实。
  // 挂 ?vrScreen=0.75 可以在头显里直接对比，不用改代码重新部署。
  const screenScale = numParam('vrScreen', 0.4, 1.2) ?? 1;
  const SCREEN_W = CFG.screen.w * screenScale;
  const SCREEN_H = CFG.screen.h * screenScale;
  const PHOTO_MAX_W = CFG.photo.maxW * screenScale;
  const PHOTO_MAX_H = CFG.photo.maxH * screenScale;

  const optionalFeatures = ['local-floor', 'bounded-floor', 'hand-tracking'];
  if (tryNativeLayers) optionalFeatures.push('layers');

  const session = await navigator.xr!.requestSession('immersive-vr', {
    optionalFeatures,
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050506);

  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 120);
  camera.position.set(0, 1.6, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // 关掉固定注视点渲染，整块银幕都按全分辨率画
  renderer.xr.setFoveation(CFG.foveation);

  // 会不会走原生合成层，进 session 就能判断 —— 这决定了渲染倍率怎么取。
  // 必须在 setSession 之前定下来：base layer 一旦建好，倍率就改不动了。
  const layersEnabled = Boolean(
    tryNativeLayers &&
    session.enabledFeatures?.includes('layers') &&
    typeof XRWebGLBinding !== 'undefined'
  );

  const nativeScale = nativeScaleOf(session);
  const scaleBase = nativeScale > 1 ? nativeScale : CFG.renderScale;
  // 有原生合成层：照片不经过眼缓冲，按原生渲染就够，多给只是白烧 GPU。
  // 没有合成层：照片要经眼缓冲重采样，而眼缓冲中心密度低于面板，
  // 这时超采样是唯一能真正提清晰度的手段，值得付这份 GPU。
  const framebufferScale = numParam('vrScale', 0.5, 2)
    ?? Math.min(2, layersEnabled ? scaleBase : scaleBase * CFG.eyeBoost);
  renderer.xr.setFramebufferScaleFactor(framebufferScale);

  // local-floor 拿不到就退回 local，至少能进得去
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
  } catch {
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  }

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const maxTexSize = renderer.capabilities.maxTextureSize || 4096;
  const maxSourceSide = Math.min(maxTexSize, MAX_CLOUDINARY_SIDE);
  /** 量化到 128 的整数倍，贴近实际占位又能稳定命中 CDN 缓存 */
  const quantize = (want: number): number => {
    const g = CFG.granularity;
    const v = Math.ceil(Math.max(512, want) / g) * g;
    return Math.min(maxSourceSide, v);
  };
  const vrSource = (src: string, size: number) =>
    cloudinaryFit(src, Math.min(size, maxSourceSide), CFG.quality, CFG.sharpen);

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

  /* ---------- 银幕 ---------- */
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W + 0.5, SCREEN_H + 0.5),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  frame.position.set(0, CFG.screen.y, CFG.screen.z - 0.05);
  scene.add(frame);

  const border = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W + 0.9, SCREEN_H + 0.9),
    new THREE.MeshBasicMaterial({ color: 0x1a1a1d })
  );
  border.position.set(0, CFG.screen.y, CFG.screen.z - 0.08);
  scene.add(border);

  // 1×1 的平面，靠 scale 适配各种宽高比
  const photoMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), photoMat);
  photo.position.set(0, CFG.screen.y, CFG.screen.z);
  photo.scale.set(PHOTO_MAX_W, PHOTO_MAX_H, 1);
  scene.add(photo);

  /* ---------- 银幕下方的信息条 ---------- */
  const hudCanvas  = document.createElement('canvas');
  hudCanvas.width  = 2048;
  hudCanvas.height = 384;
  const hudCtx     = hudCanvas.getContext('2d')!;
  const hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  const hudH = CFG.hud.w * (hudCanvas.height / hudCanvas.width);
  const hud  = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.hud.w, hudH),
    new THREE.MeshBasicMaterial({ map: hudTexture, transparent: true })
  );
  hud.position.set(0, CFG.hud.y, CFG.hud.z);
  hud.rotation.x = CFG.hud.tilt;
  scene.add(hud);

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

  /**
   * 宽 w 米的画面横跨多少像素。
   * forPanel=true 用于原生合成层（按面板密度），否则按眼缓冲实测密度。
   */
  const footprintPx = (w: number, forPanel = false): number => {
    const pxPerRad = measureEyePxPerRad() * (forPanel ? CFG.panelBoost : 1);
    // 还没进第一帧、量不到时给个保守值，第一帧后会自动修正
    return pxPerRad > 0 ? Math.round(screenRad(w) * pxPerRad) : 1408;
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
  let layersUsable = layersEnabled && Boolean(session.renderState.layers);
  let layerStatus = !tryNativeLayers
    ? 'URL 指定 ?vrLayers=0，强制走 3D Plane'
    : layersUsable
      ? '等待创建 XRQuadLayer'
      : '设备/浏览器未提供 WebXR Layers，已按 3D Plane 路径优化';
  let sourcePixels = { w: 0, h: 0 };
  let diagnosticsVersion = 0;
  /** 平滑后的帧时长，用来看有没有掉帧（掉帧会触发重投影，整幅画面拖影） */
  let frameMs = 0;

  const layerFeature = session.enabledFeatures?.includes('layers') ? 'enabled' : 'not requested/reported';
  const bumpDiagnostics = () => { diagnosticsVersion++; };

  const sizeText = (s: { w: number; h: number }) => s.w > 0 && s.h > 0 ? `${s.w}x${s.h}` : 'n/a';
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e || '未知错误');

  const baseLayerText = () => {
    const base = renderer.xr.getBaseLayer() as
      | XRWebGLLayer
      | XRProjectionLayer
      | undefined;
    if (!base) return 'n/a';
    const w = ('textureWidth' in base ? base.textureWidth : base?.framebufferWidth) ?? 0;
    const h = ('textureHeight' in base ? base.textureHeight : base?.framebufferHeight) ?? 0;
    return w > 0 && h > 0 ? `${w}x${h}` : 'n/a';
  };

  const diagnosticLines = () => {
    const mode = photoLayer && photoLayerInState
      ? 'XRQuadLayer ACTIVE'
      : layersUsable
        ? 'XRQuadLayer ready/hidden'
        : '3D Plane FALLBACK';
    const forPanel = Boolean(photoLayer && photoLayerInState);
    const foot = footprintPx(photo.scale.x, forPanel);
    const eyeDeg = measureEyePxPerRad() * Math.PI / 180;
    // 采样比 = 纹理像素 / 实际需要的像素。>1 是缩小采样（摩尔纹来源），<1 是插值（发虚）
    const ratio = foot > 0 && sourcePixels.w > 0
      ? (sourcePixels.w / (foot * zoom)).toFixed(2)
      : 'n/a';
    return [
      `VR显示路径: ${mode} | 原因: ${layerStatus}`,
      `源图: ${sizeText(sourcePixels)} | 银幕占位: ${foot}px | 采样比: ${ratio}（1.0 最佳，>1 摩尔纹，<1 发虚）`,
      `眼缓冲密度: ${eyeDeg.toFixed(1)} px/° | renderScale: ${framebufferScale.toFixed(2)} (原生 ${nativeScale.toFixed(2)}) | XR Base: ${baseLayerText()}`,
      `帧时: ${frameMs.toFixed(1)}ms${frameMs > 14 ? ' ⚠掉帧→重投影拖影' : ''} | 档位: ${loadedStep || 'n/a'} | zoom: ${zoom.toFixed(2)}x | 银幕: ${screenScale.toFixed(2)}x`,
      `features.layers: ${layerFeature} | QuadLayer: ${sizeText(photoLayerPixels)} | 可调: ?vrScreen= ?vrScale= ?vrLayers=0`,
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
        Math.min(maxTexSize, Math.round(footprintPx(w, true) * CFG.superSample))
      );
      const pixelH = Math.max(1, Math.min(maxTexSize, Math.round(pixelW * (h / w))));
      const binding = renderer.xr.getBinding();
      if (!binding?.createQuadLayer) {
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
      const binding = renderer.xr.getBinding();
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
    hudCtx.textAlign = 'center';
    hudCtx.fillStyle = 'rgba(255,255,255,0.9)';
    hudCtx.font = '600 54px system-ui, -apple-system, sans-serif';
    hudCtx.fillText(`${index + 1} / ${photos.length}　${photos[index].title}`, w / 2, 62);
    hudCtx.fillStyle = 'rgba(255,255,255,0.45)';
    hudCtx.font = '400 34px system-ui, -apple-system, sans-serif';
    const tip = note
      ?? (zoom > 1.01
        ? `已放大 ${Math.round(zoom * 100)}% · 扳机拖动 · 摇杆按下复位`
        : '摇杆上下 缩放 · 左右 翻页 · 扳机按住 拖动 · 摇杆按下 复位 · 长按侧键 退出');
    hudCtx.fillText(tip, w / 2, 118);

    hudCtx.textAlign = 'left';
    hudCtx.font = '400 24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    hudCtx.fillStyle = photoLayer && photoLayerInState
      ? 'rgba(145,255,180,0.88)'
      : 'rgba(255,204,128,0.88)';
    const lines = diagnosticLines();
    for (let i = 0; i < lines.length; i++) {
      hudCtx.fillText(lines[i], 88, 174 + i * 38);
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
    // mipmap 必须开着。纹理已经按实际采样率取，正常情况 LOD≈0、mipmap 不参与，
    // 不损失细节；但视角一斜、头一动、或者刚好差一点点缩小采样时，
    // 它就是唯一能挡住摩尔纹的东西。关掉 = 直接暴露原始采样噪声。
    tex.generateMipmaps = true;
    tex.minFilter  = THREE.LinearMipmapLinearFilter;
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
    return quantize(footprintPx(photo.scale.x, forPanel) * zoom * CFG.superSample);
  };

  const adoptTexture = (tex: THREE.Texture, step: number) => {
    texture?.dispose();
    texture = prepare(tex);
    loadedStep = Math.max(loadedStep, step);

    const img = tex.image as { width?: number; height?: number };
    sourcePixels = { w: Math.round(img.width || 0), h: Math.round(img.height || 0) };
    bumpDiagnostics();

    const aspect = img?.width && img?.height ? img.width / img.height : 3 / 2;
    let w = PHOTO_MAX_W;
    let h = w / aspect;
    if (h > PHOTO_MAX_H) { h = PHOTO_MAX_H; w = h * aspect; }
    photo.scale.set(w, h, 1);

    photoMat.map = tex;
    photoMat.color.set(picker.isOpen() ? 0x2b2b2b : 0xffffff);
    photoMat.needsUpdate = true;
    syncPhotoLayer(tex.image as TexImageSource, w, h);
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
    Math.max(512, Math.min(maxTexSize, Math.round(footprintPx(photo.scale.x, true) * CFG.superSample)));

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
    // 照片墙打开时压暗银幕，免得和缩略图抢注意力
    photoMat.color.set(next ? 0x2b2b2b : texture ? 0xffffff : 0x111111);
    setPhotoLayerInRenderState(!next);
    photo.visible = !(photoLayer && photoLayerInState);
    hud.visible = !next;
    drawHud();
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

  /* ---------- 手柄状态 ---------- */
  interface CtrlState {
    prev:  boolean[];
    latch: boolean;
    gripAt: number | null;
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
        prev: [], latch: false, gripAt: null, drag: null,
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

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const st = stateOf(src);
      const { x: ax, y: ay } = stickAxes(gp as Gamepad);
      const btn = gp.buttons;
      const trigger = btn[0]?.pressed ?? false;

      // Pico 4 菜单键不是 xr-standard 的固定按钮，常见实现会放在 6/7。
      for (const b of CFG.menuButtons) {
        if (btn[b]?.pressed && !st.prev[b]) togglePicker();
      }

      // 侧键：短按开关照片墙，长按退出 VR
      const grip = btn[1]?.pressed ?? false;
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

        st.prev = btn.map(b => b.pressed);
        continue;
      }

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

      // 摇杆按下：复位
      if ((gp.buttons[3]?.pressed ?? false) && !st.prev[3]) {
        reset();
        pulse(gp as Gamepad, 0.4, 30);
      }
      // A/B（xr-standard 的 4/5）也能翻页，方便不习惯摇杆的人
      if ((btn[4]?.pressed ?? false) && !st.prev[4]) showPhoto(index - 1);
      if ((btn[5]?.pressed ?? false) && !st.prev[5]) showPhoto(index + 1);

      st.prev = btn.map(b => b.pressed);
    }

    if (pickerOpen && !hovered) picker.setHover(null);
  };

  /* ---------- 主循环 ---------- */
  let hudTick = 0;
  // 第一张图要等第一帧：只有进了帧才量得到眼缓冲密度，
  // 否则会先按兜底值下载一张尺寸不对的，然后要么发虚要么白下一次。
  let firstShowDone = false;
  renderer.setAnimationLoop((_time, frame) => {
    if (!frame) return;
    const now = performance.now();
    const dt  = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    // 指数平滑，用来在 HUD 上看有没有掉帧
    frameMs = frameMs ? frameMs + (dt * 1000 - frameMs) * 0.05 : dt * 1000;

    if (!firstShowDone && measureEyePxPerRad() > 0) {
      firstShowDone = true;
      showPhoto(index);
    }

    readInput(frame, now, dt);
    picker.update(dt);
    paintPhotoLayer(frame);
    // 缩放后按需换更大的源图，让银幕始终接近 1:1 采样
    if (firstShowDone) refineSource();
    // 每秒刷一次诊断（帧时、采样比会持续变化）
    if (now - hudTick > 1000) { hudTick = now; drawHud(); }
    renderer.render(scene, camera);
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

  drawHud('载入中…');

  return {
    stop: () => {
      dispose();
      void session.end().catch(() => {});
    },
  };
}
