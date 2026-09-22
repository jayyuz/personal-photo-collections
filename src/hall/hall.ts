/**
 * hall — 可步行的 3D 展厅
 *
 * 一条两侧挂画的长廊，玩家操纵一个小人在里面走：
 *   W A S D / 方向键   相对镜头前后左右
 *   Shift              快走
 *   拖动鼠标           转视角
 *   走到画前 + Enter   打开灯箱看原图
 *
 * 展厅几何全是代码生成的，墙面、地面、画框都是共享 geometry + 共享 material
 * 的缩放实例，加一张照片只多三个 mesh。只有角色和脚印是外部资源
 * （public/hall/），角色 glb 没下来也能跑，会退回程序化的火柴人。
 *
 * 照片纹理按距离流式加载：远处不占显存，走近换高清。一百多张图全量常驻
 * 会吃掉上百 MB，这条流水线是这个模式能跑起来的前提，见 syncTextures。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { cloudinaryVariant } from '../vr/source';

export interface HallPhoto {
  id:        string;
  title:     string;
  src:       string;
  location?: string;
  year?:     number;
  /** 有 exif 尺寸就按真实长宽比裱框，省得等纹理到了再跳一下 */
  width?:    number;
  height?:   number;
}

export interface HallOptions {
  canvas:   HTMLCanvasElement;
  photos:   HallPhoto[];
  /** 0–1，只统计开场那几张近处的画 */
  onProgress?: (ratio: number) => void;
  onReady?:    () => void;
  /** 走近 / 走开某张画 */
  onFocus?:    (photo: HallPhoto | null) => void;
  /** 按 Enter 或直接点画面 */
  onEnter?:    (photo: HallPhoto) => void;
  /** 当前走到第几张（1 起，0 表示不在任何画附近） */
  onIndex?:    (index: number) => void;
}

export interface HallHandle {
  stop: () => void;
  /** 移动端摇杆：x 左右、y 前后，各自 -1..1 */
  setMove: (x: number, y: number) => void;
  /**
   * 暂停。灯箱盖在展厅上面时必须调用：
   * 否则方向键会同时翻灯箱的页和走展厅里的人，而且看照片时白白渲染一整个场景。
   */
  setPaused: (paused: boolean) => void;
}

/** 单位米。改这里就能整体调展厅的比例 */
const CFG = {
  /** runway 是入口背墙到开场站位的留白，也就是回头走过去读前言墙的那段距离 */
  hall:    { halfWidth: 4.2, height: 4.4, runway: 4.8 },
  /** 每侧相邻两张画的间距；左右墙错开半格，走廊里看着不会像货架 */
  slot:    3.3,
  /** 入口到第一张画的距离，以及最后一张画到尽头墙的距离 */
  margin:  4.5,
  /** 画幅。墙有 4.4m 高，画小了整面墙就空着，这个尺寸和 slot 是一起定的 */
  art:     { maxW: 2.3, maxH: 1.62, centerY: 1.66 },
  /**
   * 中庭陈设。两百米的直筒走廊光靠两边的画撑不住，
   * 每隔一段放一条悬空的橡木坐凳，走起来才有段落感。
   */
  avenue:  { everySlots: 5, offset: 1.35, seatR: 0.36 },
  /**
   * 画框是三层贴着摆的：外框盒整个在墙里（局部 z ≤ 0），卡纸凸出一点，画心再往前一点。
   * 三层的 z 区间必须严格不相交，否则画心会陷进卡纸盒体里，看到的就只剩一块白卡纸。
   */
  frame:   { border: 0.028, mat: 0.075, depth: 0.05, matDepth: 0.012, artGap: 0.002 },
  walk:    { speed: 2.9, run: 6.2, accel: 12, turn: 10 },
  camera:  { dist: 5.6, height: 2.6, lookY: 1.45, lerp: 6, fov: 55 },
  /**
   * 在同一幅画前停稳 2 秒后，自动进入正对画作的观赏机位。
   *
   * 机位是「越过肩膀看画」：相机站在画的正前方（沿走廊和画心对齐），视线严格沿
   * 墙面法线，画既在画面正中又不会被拍歪；相机退到人身后、抬到头顶之上，人就留
   * 在画面下方。
   *
   * 人正好站在画和相机之间，脑袋压住画的下缘是躲不掉的 —— 机位一错开画就偏出
   * 中心，所以改成让角色在这个机位里淡成剪影（bodyFade），照片照样整幅露出来。
   */
  viewing: {
    delayMs: 2000,
    /** 相机比人再往后退这么多。角色是大头比例，退得不够整个人会顶出画面 */
    back: 3.4,
    /** 相机离墙的距离夹在这个区间：太近装不下整幅画，太远人就成了小黑点 */
    minDist: 3.9,
    maxDist: 5.8,
    /** 比角色 1.72m 的头顶高一截，视线才能从头上越过去；再高画面俯角就太大了 */
    height: 2.5,
    /** 观赏机位下角色的不透明度：看得出是个人，又不挡住照片 */
    bodyFade: 0.42,
    lerp: 3.4,
    /** 走出这个距离才算离开这幅画，在那之前不会再自动抢一次镜头 */
    resetRange: 4.4,
  },
  character: {
    url: 'hall/personnage.glb',
    /** 模型自带的尺寸不是米，载入后按包围盒统一缩放到这个身高 */
    height: 1.72,
    /** 模型朝向和「局部 +z 是正面」的约定差多少 */
    modelYaw: 0,
    clips: { walk: 'walk', idle: 'wait' },
    /** walk 这段是按这个速度做的，实际速度不同就改 timeScale，跑起来才不像慢动作 */
    clipSpeed: 2.9,
  },
  footprints: {
    spacing: 0.46,
    side: 0.105,
    /** 单只脚印在地上的长度（米），贴图按原始长宽比配宽度 */
    length: 0.26,
    opacity: 0.5,
    holdMs: 2600,
    fadeMs: 2200,
    max: 40,
    urls: { left: 'hall/footprintL.png', right: 'hall/footprintR.png' },
  },
  /**
   * 「在看这张画」的判定。看画是站在几米开外正对着看的，直线距离没法区分
   * 「正对着这张」和「贴着墙路过隔壁那张」，所以拆成两个方向分别卡：
   * along 是沿走廊的错开量（要小），out 是离墙的距离（可以宽松）。
   */
  focus: {
    /** 人到画心的最大距离 */
    range: 5.2,
    /**
     * 画心偏离视线中心的最大角度（存余弦，省得每帧开反三角）。
     * 相机水平半视角约 38°，收到 32° 免得选中画面边缘、甚至已经出画的那张。
     */
    minCos: Math.cos(32 * Math.PI / 180),
    /** 偏离视线的代价，折算成「等效距离」的倍数：斜着的那张要近得多才抢得过正前方 */
    angleBias: 2.2,
    /** 停下后自动转向正对的额外门槛，比 range 紧得多：得真的走过去才转 */
    turnRange: 3.6,
  },
  /** 纹理档位的距离阈值：近处高清、中距缩略、远处不加载 */
  tier:    { near: 9, far: 26, drop: 34 },
  /** 同时最多几个请求在飞，避免走一步刷出几十个连接 */
  maxLoads: 4,
  /** 开场前先把最近的几张加载出来，进度条走的就是这几张 */
  preload: 8,
};

/** 纹理档位 → Cloudinary 宽度。0 是「没加载」 */
const TIER_WIDTH = [0, 448, 1280];

/** 画框、画心的朝向：-1 挂在左墙（朝 +x），+1 挂在右墙（朝 -x） */
type Side = -1 | 1;

/** 选中时画框放大到的比例，写成常量省得每帧 new 一个 Vector3 */
const FOCUS_SCALE = new THREE.Vector3(1.05, 1.05, 1.05);

interface Frame {
  photo:  HallPhoto;
  /** 外框 + 卡纸 + 画心，选中时整组一起放大 */
  group:  THREE.Group;
  outer:  THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  board:  THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  /** 画心平面，纹理挂在它的材质上 */
  art:    THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 画所在的位置，算距离用 */
  pos:    THREE.Vector3;
  side:   Side;
  index:  number;
  tier:   number;
  /** 正在请求的档位，防止同一张画排队请求两次 */
  loading: number;
  texture: THREE.Texture | null;
}

/** 给定真实长宽比，算出画心在展墙上的尺寸。横竖图共用同一组最大边界。 */
function artSize(aspect: number): { w: number; h: number } {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 3 / 2;
  const h = Math.min(CFG.art.maxH, CFG.art.maxW / safe);
  return { w: h * safe, h };
}

/** 画一张灰阶 canvas 贴图，用来做地面拼缝、角色投影这类不值得下文件的小纹理 */
function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  if (ctx) draw(ctx, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 地面石材。学的是苹果店那种大板石灰岩：暖灰底、极低对比的云斑、
 * 拼缝细到走近才看得见 —— 和原来那种高对比水磨石正相反，碎点一多整条走廊就吵。
 */
function stoneTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#e7e4de';
    ctx.fillRect(0, 0, s, s);
    /*
     * 只留高频的细砂点。低频的云斑试过，问题是一张贴图铺满整条走廊，
     * 每块板上的斑一模一样，远看就是一地规则的污渍 —— 石材宁可平，不能有图案。
     */
    for (let i = 0; i < 4200; i++) {
      const g = 196 + Math.random() * 44;
      ctx.fillStyle = `rgba(${g},${g - 3},${g - 8},${0.08 + Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, 0.4 + Math.random() * 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 拼缝：细、浅，走近才看得见一格一格
    ctx.strokeStyle = 'rgba(178,174,167,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 浅橡木：暖白底 + 细长木纹。苹果店里的木头都是这种发白的白橡，不是深胡桃 */
function oakTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#dcc7a9';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 110; i++) {
      const y = Math.random() * s;
      // 一成左右是深一点的节理线，其余是浅纹，全直线看着像塑料贴皮，给点起伏
      const knot = Math.random() < 0.1;
      ctx.strokeStyle = knot
        ? 'rgba(157,124,86,0.42)'
        : `rgba(190,163,128,${0.1 + Math.random() * 0.22})`;
      ctx.lineWidth = knot ? 1.6 : 0.7 + Math.random() * 1.8;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 32; x <= s; x += 32) ctx.lineTo(x, y + Math.sin(x / s * Math.PI * 2 + i) * 2.4);
      ctx.stroke();
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * 入口背墙上的前言。走进长廊之前转个身才看得到，是开场的那一眼。
 *
 * 排版跟着展厅一起走苹果那套：一句居中的大标题、一条细分割线、两行小字落款，
 * 全用无衬线（中文 PingFang），颜色用苹果那三档灰。原来是宋体引文的美术馆做法，
 * 和白墙发光顶棚的店堂对不上。
 *
 * 尺度是按「站在走廊里回头看」定的，不是按看网页定的。相机只能绕到角色身前，
 * 所以看这面墙最近也有 11.7m（`zNear - (heroRearZ - camera.dist)`），
 * 正文字高得做到 0.3m 上下才读得清 —— 也正因为放这么大，只放得下这几行。
 */
const PREFACE = {
  label: 'PHOTOGRAPHY',
  /** 主标题拆成两行自己控制断句，交给画布自动折行会断在奇怪的地方 */
  head: ['每一次按下快门', '都是与时间的一场对话'],
  quotes: [
    { line: '你最初的一万张照片，是最糟的。', by: 'HENRI CARTIER-BRESSON' },
    { line: '照片不是拍来的，是做出来的。',   by: 'ANSEL ADAMS' },
  ],
  font: {
    latin: `'Archivo', -apple-system, system-ui, sans-serif`,
    cn: `'PingFang SC', -apple-system, 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans CJK SC', system-ui, sans-serif`,
  },
  /** 画布像素；贴到墙上是 7.0m 宽，约 293 px/m */
  canvas: { w: 2048, h: 1024 },
};

/** 按字距逐字画一行。ctx.letterSpacing 各家支持还不齐，自己摆最稳。返回实际占宽。 */
function drawTracked(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, track: number
): number {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + track;
  }
  return Math.max(0, cx - track - x);
}

/** 同样的字距，只量宽不画，用来把加了字距的一行摆居中 */
function trackedWidth(ctx: CanvasRenderingContext2D, text: string, track: number): number {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + track;
  return Math.max(0, w - track);
}

/** 把前言画进画布。下面的数字都是 PREFACE.canvas 那块画布上的像素。 */
function drawPreface(cv: HTMLCanvasElement): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);

  const mid = cv.width / 2;
  const { latin, cn } = PREFACE.font;

  ctx.font = `600 36px ${latin}`;
  ctx.fillStyle = '#86868b';
  drawTracked(ctx, PREFACE.label, mid - trackedWidth(ctx, PREFACE.label, 18) / 2, 210, 18);

  // 主标题：苹果的正文黑是 #1d1d1f，纯黑在白墙上反而显脏
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1d1d1f';
  ctx.font = `600 132px ${cn}`;
  PREFACE.head.forEach((line, i) => ctx.fillText(line, mid, 400 + i * 168));

  ctx.fillStyle = '#d2d2d7';
  ctx.fillRect(mid - 110, 660, 220, 2);

  PREFACE.quotes.forEach((q, i) => {
    const y = 800 + i * 122;
    ctx.fillStyle = '#6e6e73';
    ctx.font = `400 62px ${cn}`;
    ctx.fillText(q.line, mid, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#a1a1a6';
    ctx.font = `600 34px ${latin}`;
    drawTracked(ctx, q.by, mid - trackedWidth(ctx, q.by, 8) / 2, y + 48, 8);
    ctx.textAlign = 'center';
  });

  ctx.textAlign = 'left';
}

/** 角色脚下的一团软阴影，代替真实阴影贴图 */
function blobTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/**
 * 脚印贴图。原图是白底黑印的 RGB，alpha 通道整张都是 255，直接当 map 用
 * 会在地上糊一块白方片。这里转成「深色 + 亮度取反当 alpha」，
 * 顺便裁到墨迹的外接框 —— 印子只占原图中间 1/5，不裁的话 quad 要放大五倍才够看。
 *
 * 返回 null 表示图没取到，调用方退回不画脚印。
 */
function footprintTexture(img: HTMLImageElement): { tex: THREE.CanvasTexture; aspect: number } | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  if (!sctx) return null;
  sctx.drawImage(img, 0, 0);
  const px = sctx.getImageData(0, 0, w, h).data;

  // 角落当作背景色；比它暗到一定程度才算墨迹
  const bg = px[0];
  const cut = bg - 40;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4] < cut) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;

  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const octx = out.getContext('2d');
  if (!octx) return null;
  const dst = octx.createImageData(cw, ch);
  const out8 = dst.data;
  // 背景亮度映到 alpha 0、最黑映到 alpha 1，中间线性过渡，边缘的抗锯齿才留得住
  const range = Math.max(1, bg - 20);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const lum = px[((y + y0) * w + (x + x0)) * 4];
      const a = Math.max(0, Math.min(1, (bg - lum) / range));
      const i = (y * cw + x) * 4;
      out8[i] = 0x2a; out8[i + 1] = 0x29; out8[i + 2] = 0x26;
      out8[i + 3] = Math.round(a * 255);
    }
  }
  octx.putImageData(dst, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: cw / ch };
}

interface Footprint {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  born: number;
}

interface Figure {
  root: THREE.Object3D;
  /** 整具身体共用一张材质，相机贴太近时靠它整体淡出 */
  material: THREE.MeshStandardMaterial;
  step: (phase: number, gait: number) => void;
  dispose: () => void;
}

/**
 * 角色 glb 还没到（或者取不到）时顶上的火柴人：胶囊躯干 + 球头 + 四根方棍。
 * 走路是拿相位驱动的正弦，四肢交叉摆动，够看出「在走」就行。
 */
function buildFallbackFigure(): Figure {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x16171c, roughness: 0.62, metalness: 0.05 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.4, 4, 12), skin);
  torso.position.y = 1.18;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), skin);
  head.position.y = 1.62;

  const limb = new THREE.BoxGeometry(1, 1, 1);
  /** 四肢都绕顶端转，所以几何体先往下挪半根，再给个 pivot 控制旋转 */
  const makeLimb = (w: number, len: number, x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(limb, skin);
    mesh.scale.set(w, len, w);
    mesh.position.y = -len / 2;
    pivot.add(mesh);
    root.add(pivot);
    return pivot;
  };
  const armL = makeLimb(0.062, 0.48, -0.175, 1.38);
  const armR = makeLimb(0.062, 0.48, 0.175, 1.38);
  const legL = makeLimb(0.088, 0.76, -0.085, 0.78);
  const legR = makeLimb(0.088, 0.76, 0.085, 0.78);

  root.add(torso, head);

  const step = (phase: number, gait: number) => {
    const s = Math.sin(phase) * gait;
    const c = Math.cos(phase) * gait;
    legL.rotation.x = s * 0.72;
    legR.rotation.x = -s * 0.72;
    armL.rotation.x = -s * 0.55;
    armR.rotation.x = s * 0.55;
    // 每迈一步身体微微起伏，双倍频率才对得上左右脚
    torso.position.y = 1.18 + Math.abs(c) * 0.025 * gait;
    head.position.y = 1.62 + Math.abs(c) * 0.025 * gait;
  };

  const dispose = () => {
    torso.geometry.dispose();
    head.geometry.dispose();
    limb.dispose();
    skin.dispose();
  };

  return { root, material: skin, step, dispose };
}

export function startHall(opts: HallOptions): HallHandle {
  const { canvas, photos, onProgress, onReady, onFocus, onEnter, onIndex } = opts;

  /* ---------- 基础 ---------- */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /*
   * 展厅走色调映射，照片不走。
   *
   * 不映射的话亮部是硬切的：墙面一过 1.0 就是一片死白，墙角、顶棚和远处全糊在一起。
   * Neutral（Khronos PBR Neutral）只压高光、不动色相，正好是这种大白空间要的。
   * 照片和脚印的材质都写了 toneMapped: false，映射碰不到它们，颜色还是原样。
   */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.25;

  /** 整个实例的生命周期标记。照片纹理、角色 glb、脚印图、网络字体都要靠它决定回调还该不该落地 */
  let stopped = false;

  const scene = new THREE.Scene();
  const AIR = 0xf4f3f1;
  scene.background = new THREE.Color(AIR);
  // 亮堂的店堂里不该有可见的雾，推远到只在长廊尽头收一下
  scene.fog = new THREE.Fog(AIR, 34, 96);

  /*
   * 环境贴图：一张上白下灰的渐变当全景图，过一遍 PMREM 就是一间匀光的白盒子。
   * Standard 材质的柔和漫反射和高光全靠它 —— 没有环境贴图的金属只会黑成一块。
   *
   * 原来用的是 three 自带的 RoomEnvironment，那间屋子的灯偏在一侧，
   * 背着光的入口前言墙就比两侧墙灰一整档。渐变只分上下、不分朝向，四面墙才一样白。
   * 生成一次，之后每帧零成本。
   */
  const envTex = canvasTexture(64, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, '#ffffff');   // 顶棚
    g.addColorStop(0.5, '#f1efeb'); // 四壁
    g.addColorStop(1, '#d9d5cf');   // 地面
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(envTex);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();
  envTex.dispose();

  const camera = new THREE.PerspectiveCamera(CFG.camera.fov, 1, 0.1, 220);

  /* ---------- 展厅尺寸 ---------- */
  const slots = Math.max(1, Math.ceil(photos.length / 2));
  const halfW = CFG.hall.halfWidth;
  const wallH = CFG.hall.height;
  /** 走廊沿 -z 延伸，zNear 这头是入口背墙（盒体从 zNear 铺到 zNear+0.3） */
  const zNear = CFG.camera.dist + CFG.hall.runway;
  const zFar  = -(CFG.margin + slots * CFG.slot);
  const depth = zNear - zFar;
  const zMid  = (zNear + zFar) / 2;
  /**
   * 人只受「别穿墙」这一条约束，相机够不够得着是弹簧臂的事（见 armLength）。
   * 别为了给相机腾地方去限制人的走位 —— 那样人就走不到入口墙跟前看前言了。
   */
  const heroBack  = zNear - 0.8;
  const heroFront = zFar + 1.2;
  /** 开场站位：留出完整一条相机臂，第一眼不会是怼在后脑勺上 */
  const heroStartZ = zNear - 0.5 - CFG.camera.dist;

  /* ---------- 地面 / 墙 / 天花 ---------- */
  /*
   * 整体是苹果零售店那套：暖白墙、大板石材地面、整片发光的顶棚、细边阳极氧化铝，
   * 再加浅橡木做唯一的暖色。克制在这几样材质里，长廊才不会看着像样板间。
   */
  const stoneMap = stoneTexture();
  // 一块板 1.2m 见方，拼缝密一点才像铺出来的地，而不是一张放大的贴图
  stoneMap.repeat.set(halfW * 2 / 1.2, depth / 1.2);
  // 走廊很长，地面几乎全是掠射角，没有各向异性过滤远处会糊成一片灰
  stoneMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, depth),
    /*
     * 哑光石材，但留一点透明度：地面底下压着一份镜像的发光顶棚（见 glow 那段），
     * 透出来的那一点点就是苹果店里最认人的那条地面反光。真做平面反射要多渲一遍
     * 整个场景，为这点效果不值。
     */
    new THREE.MeshStandardMaterial({
      map: stoneMap, roughness: 0.36, metalness: 0.04, transparent: true, opacity: 0.84,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = zMid;
  /*
   * 地面成了半透明，就排进了透明队列，默认按距离排序 —— 站在走廊中间时，
   * 地面这块大面片的中心反而比远处的脚印、接触阴影更近，会盖在它们上面。
   * 钉死在最前面画，透明的那几层才叠得对。
   */
  floor.renderOrder = -1;
  scene.add(floor);

  /** 橡木台和尽头木墙各自的尺度差太多，共用一张画布、各自一份 repeat */
  const oakMap = oakTexture();
  const endOakMap = oakMap.clone();
  endOakMap.needsUpdate = true;   // clone 出来的是另一张 GL 贴图，得自己标一次上传
  const wallMat    = new THREE.MeshStandardMaterial({ color: 0xf5f4f2, roughness: 0.88, metalness: 0 });
  const oakMat     = new THREE.MeshStandardMaterial({ map: oakMap, roughness: 0.52, metalness: 0 });
  const endOakMat  = new THREE.MeshStandardMaterial({ map: endOakMap, roughness: 0.55, metalness: 0 });
  /** 墙脚 / 木台底下的那道暗缝。苹果店里不做踢脚线，靠一条阴影缝收口 */
  const revealMat  = new THREE.MeshStandardMaterial({ color: 0x2f2f31, roughness: 1 });
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f6, roughness: 1 });
  const box = new THREE.BoxGeometry(1, 1, 1);

  /** 共用一个 1×1×1 的 box，靠 scale / position 摆出所有墙体 */
  const addBox = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(box, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  addBox(wallMat, 0.3, wallH, depth, -halfW - 0.15, wallH / 2, zMid);        // 左墙
  addBox(wallMat, 0.3, wallH, depth,  halfW + 0.15, wallH / 2, zMid);        // 右墙
  addBox(wallMat, halfW * 2 + 0.6, wallH, 0.3, 0, wallH / 2, zFar - 0.15);   // 尽头
  addBox(wallMat, halfW * 2 + 0.6, wallH, 0.3, 0, wallH / 2, zNear + 0.15);  // 入口背墙
  addBox(ceilingMat, halfW * 2 + 0.6, 0.2, depth, 0, wallH + 0.1, zMid);

  /*
   * 尽头墙包一整面浅橡木，长廊尽头才有个落点。四周留一圈白墙收边，
   * 木面再往前凸 20mm —— 齐平的话看着像贴了张木纹纸。
   */
  const endOakW = halfW * 2 - 0.8;
  const endOakH = wallH - 0.7;
  endOakMap.repeat.set(endOakW / 2.2, endOakH / 2.2);
  addBox(endOakMat, endOakW, endOakH, 0.02, 0, endOakH / 2 + 0.25, zFar + 0.01);

  /*
   * 靠墙的浅橡木长条台。苹果店的木台都是挂在墙上的，底下留一条暗缝显得轻。
   * 照片下沿在 0.9m 上下，0.44m 的台面不会打架；人被挡在 heroSide 之外，不会穿过去。
   */
  const benchTop = 0.44;
  const benchDepth = 0.42;
  const benchLen = depth - CFG.margin;
  const benchZ = zMid - CFG.margin / 2;
  oakMap.repeat.set(benchDepth / 2.2, benchLen / 2.2);

  /** 贴地的接触阴影：靠墙一侧最深，往外 0.6m 化开。没有它木台像是浮在地上 */
  const contactTex = canvasTexture(64, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, s, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.26)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  const contactMat = new THREE.MeshBasicMaterial({
    map: contactTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });

  for (const s of [-1, 1] as const) {
    const x = s * (halfW - benchDepth / 2);
    addBox(oakMat, benchDepth, 0.1, benchLen, x, benchTop - 0.05, benchZ);
    // 台面下的暗缝：悬空的错觉全在这条线上
    addBox(revealMat, benchDepth - 0.06, 0.06, benchLen, x, benchTop - 0.13, benchZ);

    const shade = new THREE.Mesh(new THREE.PlaneGeometry(0.62, benchLen), contactMat);
    shade.rotation.x = -Math.PI / 2;
    shade.position.set(s * (halfW - 0.31), 0.006, benchZ);
    // 贴图的深色边在局部 -x，右墙那条要整片翻过来才朝着墙
    shade.scale.x = s;
    scene.add(shade);
  }

  // 墙脚的阴影缝，替掉原来那圈深色踢脚
  addBox(revealMat, 0.02, 0.035, depth, -halfW + 0.01, 0.0175, zMid);
  addBox(revealMat, 0.02, 0.035, depth,  halfW - 0.01, 0.0175, zMid);

  /* ---------- 中庭坐凳 ---------- */
  /**
   * 挡人的陈设，都当成圆柱处理：人撞上去要被推开，相机臂也要在它前面收住，
   * 不然镜头会从坐凳里穿过去。
   */
  const blockers: { x: number; z: number; r: number }[] = [];

  const seatMap = oakMap.clone();
  seatMap.needsUpdate = true;
  seatMap.repeat.set(0.58 / 2.2, 1.9 / 2.2);
  const seatMat = new THREE.MeshStandardMaterial({ map: seatMap, roughness: 0.5 });
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTexture(), transparent: true, depthWrite: false,
  });

  const addSeat = (x: number, z: number) => {
    addBox(seatMat, 0.58, 0.1, 1.9, x, 0.42, z);
    addBox(revealMat, 0.5, 0.08, 1.82, x, 0.33, z);
    // 两片薄脚缩在暗缝里，坐凳就像浮着
    addBox(revealMat, 0.46, 0.29, 0.07, x, 0.145, z - 0.62);
    addBox(revealMat, 0.46, 0.29, 0.07, x, 0.145, z + 0.62);
    // 脚下的一团软阴影，和角色脚下用的是同一张图
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(x, 0.006, z);
    blob.scale.set(1.9, 1.9, 1);
    scene.add(blob);
    for (const d of [-0.62, 0, 0.62]) blockers.push({ x, z: z + d, r: CFG.avenue.seatR });
  };

  /*
   * 每 everySlots 个画位放一条，左右轮流错开走廊中线：全摆正中间的话，
   * 一路看过去就是一串挡在视线上的东西，走廊的纵深也被堵死了。
   *
   * 每条的 z 对齐到「对面那堵墙」的画位上。自动正对时相机贴着对面墙、平着看过来，
   * 同侧的陈设要是和画同一个 z，就正好横在相机和画之间 —— 错开半格（1.65m）才让得开。
   * 两头留空，别顶在门口和尽头墙上。
   */
  for (let k = 0; ; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const slot = CFG.avenue.everySlots * k + 2;
    const z = -(CFG.margin + CFG.slot * (slot + (side === -1 ? 0.5 : 1)));
    if (z < zFar + 3.5) break;
    addSeat(side * CFG.avenue.offset, z);
  }

  /*
   * 入口背墙的前言。背墙盒体从 zNear 铺到 zNear+0.3，所以内侧面正好在 zNear，
   * 字幕面片往走廊这边挪 12mm 躲开 z-fighting，再转 180° 让正面朝向走廊。
   *
   * 用 MeshStandardMaterial 而不是 Basic：和墙面同一套 roughness，
   * 补光扫过来时字和墙一起明暗，才不像后贴上去的一张图。
   */
  const prefaceCv = document.createElement('canvas');
  prefaceCv.width  = PREFACE.canvas.w;
  prefaceCv.height = PREFACE.canvas.h;
  drawPreface(prefaceCv);
  const prefaceTex = new THREE.CanvasTexture(prefaceCv);
  prefaceTex.colorSpace = THREE.SRGBColorSpace;
  prefaceTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // Archivo 是 display=swap 的网络字体，首画很可能落在回退字形上，到货后重画一遍
  document.fonts.ready.then(() => {
    if (stopped) return;
    drawPreface(prefaceCv);
    prefaceTex.needsUpdate = true;
  });

  const prefaceW = 7.0;
  const preface = new THREE.Mesh(
    new THREE.PlaneGeometry(prefaceW, prefaceW * PREFACE.canvas.h / PREFACE.canvas.w),
    new THREE.MeshStandardMaterial({ map: prefaceTex, transparent: true, roughness: 0.95, metalness: 0 })
  );
  // 抬到墙的上半部：角色有 1.72m 高，站在正中间回头看时会压住下面的字
  preface.position.set(0, 2.42, zNear - 0.012);
  preface.rotation.y = Math.PI;
  scene.add(preface);
  /*
   * 发光顶棚。苹果店的天花是一整片匀光的膜，没有一盏看得见的灯，
   * 所以这里不摆灯带，直接铺一张不受光的白面片，两侧各留一条白墙当灯槽收口。
   *
   * 面片上印着膜的分格缝：一整片纯白铺过去，远处会和雾连成一团，
   * 长廊就没有了纵深。一条一条缝往前收，眼睛才读得出这条廊有多长。
   */
  const glowW = halfW * 2 - 1.1;
  const glowL = depth - 0.6;
  const glowMap = canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(214,214,210,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);
  });
  glowMap.wrapS = glowMap.wrapT = THREE.RepeatWrapping;
  glowMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
  glowMap.repeat.set(glowW / 2.4, glowL / 2.4);
  // toneMapped: false —— 顶棚是光源本身，压了高光它就成了一片灰
  const glowMat = new THREE.MeshBasicMaterial({ map: glowMap, toneMapped: false });
  addBox(glowMat, glowW, 0.03, glowL, 0, wallH - 0.015, zMid);
  // 地面底下的镜像顶棚，隔着半透明的石材透上来就是那条柔和的反光
  addBox(glowMat, glowW, 0.03, glowL, 0, -(wallH - 0.015), zMid);

  /* ---------- 灯光 ---------- */
  /*
   * 匀、亮、没有硬阴影。主力是环境贴图和半球光，方向光只留一点点，
   * 用来让墙面和画框有个极淡的方向感 —— 打太足就成了打光的美术馆，不是苹果店。
   */
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe8e4dc, 0.35));
  /*
   * 方向光几乎垂直往下打。斜着打的话背向光的那面墙会明显发灰 ——
   * 入口前言墙就是这么被压暗的，而匀光的店堂里四面墙该一样白。
   */
  const key = new THREE.DirectionalLight(0xffffff, 0.3);
  key.position.set(1, 10, 1.5);
  scene.add(key);
  // 跟着角色走的一盏补光，免得长廊深处墙面糊成一片。贴着墙会烧出一圈光斑，见 tick 里的 0.3
  const lamp = new THREE.PointLight(0xfff8ee, 5, 22, 2);
  lamp.position.y = 3.4;
  scene.add(lamp);

  /* ---------- 画框 ---------- */
  // 细边阳极氧化铝 + 纯白卡纸。金属的质感全来自环境贴图，别把 roughness 调高
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xc6cacd, roughness: 0.3, metalness: 0.85 });
  const matMat   = new THREE.MeshStandardMaterial({ color: 0xfcfcfb, roughness: 0.85 });
  const plane    = new THREE.PlaneGeometry(1, 1);
  const frames: Frame[] = [];

  photos.forEach((photo, i) => {
    const side: Side = i % 2 === 0 ? -1 : 1;
    const slot = Math.floor(i / 2);
    // 右墙整体后移半格，两侧的画互相错开
    const z = -(CFG.margin + slot * CFG.slot + (side === 1 ? CFG.slot / 2 : 0));

    // EXIF 只用作纹理到达前的占位尺寸；手机照片常带旋转标记，最终以解码后纹理为准。
    const aspect = photo.width && photo.height ? photo.width / photo.height : 3 / 2;
    const { w, h } = artSize(aspect);

    const group = new THREE.Group();
    group.position.set(side * (halfW - 0.02), CFG.art.centerY, z);
    // 左墙的画朝 +x，右墙的朝 -x
    group.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;

    const { border, mat: matW, depth: d, matDepth, artGap } = CFG.frame;
    const outer = new THREE.Mesh(box, frameMat);
    outer.scale.set(w + (border + matW) * 2, h + (border + matW) * 2, d);
    outer.position.z = -d / 2;                    // 整个外框埋在墙里，正面齐平 z=0
    const board = new THREE.Mesh(box, matMat);
    board.scale.set(w + matW * 2, h + matW * 2, matDepth);
    board.position.z = matDepth / 2;              // 卡纸从 0 凸到 matDepth

    const art = new THREE.Mesh(
      plane,
      // 纹理没到之前先用中性灰占位，比留一块纯白突兀感小
      new THREE.MeshBasicMaterial({ color: 0xd6d4ce, toneMapped: false })
    );
    art.scale.set(w, h, 1);
    art.position.z = matDepth + artGap;           // 画心贴在卡纸正面之外

    group.add(outer, board, art);
    scene.add(group);

    frames.push({
      photo, group, outer, board, art, side, index: i, tier: 0, loading: 0, texture: null,
      pos: group.position.clone(),
    });
  });

  /* ---------- 纹理流式加载 ---------- */
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  let inFlight = 0;

  /** 纹理解码后按真实朝向同步改三层，不能只改画心，否则竖图会留在横框里。 */
  const resizeFrame = (f: Frame, aspect: number) => {
    const { w, h } = artSize(aspect);
    const { border, mat: matW } = CFG.frame;
    f.outer.scale.x = w + (border + matW) * 2;
    f.outer.scale.y = h + (border + matW) * 2;
    f.board.scale.x = w + matW * 2;
    f.board.scale.y = h + matW * 2;
    f.art.scale.set(w, h, 1);
  };

  const applyTexture = (f: Frame, tex: THREE.Texture, tier: number) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    f.texture?.dispose();
    f.texture = tex;
    f.tier = tier;
    const m = f.art.material;
    m.map = tex;
    m.color.setHex(0xffffff);
    m.needsUpdate = true;

    // 浏览器已经应用 EXIF orientation；naturalWidth/Height 才是页面最终看到的真实方向。
    const img = tex.image as {
      naturalWidth?: number; naturalHeight?: number; width?: number; height?: number;
    } | undefined;
    const width  = img?.naturalWidth  || img?.width;
    const height = img?.naturalHeight || img?.height;
    if (width && height) resizeFrame(f, width / height);
  };

  const dropTexture = (f: Frame) => {
    f.texture?.dispose();
    f.texture = null;
    f.tier = 0;
    const m = f.art.material;
    m.map = null;
    m.color.setHex(0xd6d4ce);
    m.needsUpdate = true;
  };

  const request = (f: Frame, tier: number, onDone?: () => void) => {
    f.loading = tier;
    inFlight++;
    loader.load(
      cloudinaryVariant(f.photo.src, TIER_WIDTH[tier], 82),
      (tex) => {
        inFlight--;
        f.loading = 0;
        if (stopped) { tex.dispose(); return; }
        // 等待期间可能已经走远了，这时候拿到的高清图直接扔掉
        if (tier >= f.tier) applyTexture(f, tex, tier);
        else tex.dispose();
        onDone?.();
      },
      undefined,
      () => {
        inFlight--;
        f.loading = 0;
        onDone?.();
      }
    );
  };

  /** 按离角色的距离决定每张画该在哪一档，近的先排队 */
  const syncTextures = (from: THREE.Vector3) => {
    if (inFlight >= CFG.maxLoads) return;
    const want: { f: Frame; tier: number; d: number }[] = [];
    for (const f of frames) {
      const d = f.pos.distanceTo(from);
      const tier = d < CFG.tier.near ? 2 : d < CFG.tier.far ? 1 : 0;
      if (tier === 0 && f.tier > 0 && d > CFG.tier.drop) { dropTexture(f); continue; }
      if (tier > f.tier && tier > f.loading) want.push({ f, tier, d });
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (inFlight >= CFG.maxLoads) break;
      request(w.f, w.tier);
    }
  };

  /* ---------- 开场预载 ---------- */
  /*
   * 进度条统计两类任务：最近的几张画，以及角色模型。glb 有 2MB，
   * 不算进去的话进度条会先走满、再干等着模型，看着像卡住了。
   */
  const head = frames.slice(0, Math.min(CFG.preload, frames.length));
  const totalTasks = head.length + 1;
  let doneTasks = 0;
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    onReady?.();
  };
  const taskDone = () => {
    doneTasks++;
    onProgress?.(doneTasks / totalTasks);
    if (doneTasks >= totalTasks) begin();
  };
  head.forEach(f => request(f, 1, taskDone));

  /* ---------- 角色与相机 ---------- */
  /*
   * hero 只管位置和朝向，身体挂在 body 里，等 glb 到了整组换掉。
   * 分成两层是因为模型的缩放/居中/朝向修正都只属于那一具身体，
   * 不该和走位逻辑纠缠在一起。
   */
  const hero = new THREE.Group();
  hero.position.set(0, 0, heroStartZ);
  hero.rotation.y = Math.PI;      // 面朝走廊深处（局部 +z 转到世界 -z）
  scene.add(hero);

  const heroShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false })
  );
  heroShadow.rotation.x = -Math.PI / 2;
  heroShadow.position.y = 0.012;
  hero.add(heroShadow);

  const body = new THREE.Group();
  hero.add(body);

  let figure: Figure | null = buildFallbackFigure();
  body.add(figure.root);
  /** 当前这具身体的材质，glb 换上来时跟着换。淡出角色用的就是它 */
  let bodyMat = figure.material;
  let mixer: THREE.AnimationMixer | null = null;
  /** 驱动当前这具身体。speed 是米/秒，gait 是 0（站着）到 1（全速） */
  let animateBody = (_dt: number, phase: number, gait: number, _speed: number) => {
    figure?.step(phase, gait);
  };

  new GLTFLoader().load(
    `${import.meta.env.BASE_URL}${CFG.character.url}`,
    (gltf) => {
      if (stopped) return;
      const model = gltf.scene;
      // glb 里没带材质，和展厅里其它东西统一用一张哑光深色
      const skin = new THREE.MeshStandardMaterial({ color: 0x16171c, roughness: 0.62, metalness: 0.05 });
      model.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = skin;
        // 蒙皮网格的包围球是按绑定姿势算的，抬手迈腿会超出去被误剔除
        m.frustumCulled = false;
      });

      // 模型单位不是米：量出包围盒，缩放到设定身高，再把脚底对到 y=0、水平居中
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -bounds.min.y, -center.z);

      const rig = new THREE.Group();
      rig.scale.setScalar(CFG.character.height / (size.y || 1));
      rig.rotation.y = CFG.character.modelYaw;
      rig.add(model);

      body.remove(figure!.root);
      figure!.dispose();
      figure = null;
      body.add(rig);
      bodyMat = skin;

      // walk 和 wait 同时播，按步态权重交叉淡入，起步停步不会硬切
      mixer = new THREE.AnimationMixer(model);
      const walk = THREE.AnimationClip.findByName(gltf.animations, CFG.character.clips.walk);
      const idle = THREE.AnimationClip.findByName(gltf.animations, CFG.character.clips.idle);
      const walkAction = walk ? mixer.clipAction(walk) : null;
      const idleAction = idle ? mixer.clipAction(idle) : null;
      walkAction?.play();
      idleAction?.play();

      animateBody = (dt, _phase, gait, speed) => {
        if (walkAction) {
          walkAction.setEffectiveWeight(gait);
          walkAction.timeScale = THREE.MathUtils.clamp(speed / CFG.character.clipSpeed, 0.35, 2.4);
        }
        idleAction?.setEffectiveWeight(1 - gait);
        mixer!.update(dt);
      };
      taskDone();
    },
    undefined,
    () => {
      // 模型没取到不算故障：火柴人照样能走，别把进度条卡死在这儿
      console.warn('[hall] 角色模型加载失败，沿用程序化小人');
      taskDone();
    }
  );

  /** 相机在角色身后的方位角。0 表示正后方在 +z 一侧，也就是从入口往里看 */
  let yaw = 0;
  let heading = Math.PI;          // 角色朝向，跟着移动方向平滑转
  let phase = 0;                  // 走路相位
  let gait = 0;                   // 0 站着 1 全速，用来淡入淡出四肢摆动
  const vel = new THREE.Vector3();

  camera.position.set(0, CFG.camera.height, hero.position.z + CFG.camera.dist);

  /* ---------- 脚印 ---------- */
  /*
   * 左右两张贴图各自一个 geometry（长宽比可能不同），图异步到货，
   * 没到之前 stamp 是空的，走路就先不留印。
   */
  const stamp: Partial<Record<'left' | 'right', {
    geo: THREE.PlaneGeometry;
    tex: THREE.CanvasTexture;
  }>> = {};

  (['left', 'right'] as const).forEach(foot => {
    const img = new Image();
    img.onload = () => {
      if (stopped) return;
      const made = footprintTexture(img);
      if (!made) return;
      const { length } = CFG.footprints;
      stamp[foot] = {
        tex: made.tex,
        geo: new THREE.PlaneGeometry(length * made.aspect, length),
      };
    };
    img.src = `${import.meta.env.BASE_URL}${CFG.footprints.urls[foot]}`;
  });

  const footprints: Footprint[] = [];
  let footprintDistance = 0;
  let nextFoot: 'left' | 'right' = 'left';
  const footprintBasis = new THREE.Matrix4();
  const footprintRight = new THREE.Vector3();
  const footprintForward = new THREE.Vector3();
  const footprintUp = new THREE.Vector3(0, 1, 0);

  const removeFootprint = (index: number) => {
    const fp = footprints[index];
    scene.remove(fp.mesh);
    fp.mesh.material.dispose();
    footprints.splice(index, 1);
  };

  const leaveFootprint = (now: number) => {
    const shoe = stamp[nextFoot];
    if (!shoe) return;
    const len = Math.hypot(vel.x, vel.z);
    if (len < 0.05) return;
    footprintForward.set(vel.x / len, 0, vel.z / len);
    // local X × local Y 必须得到 local Z(up)，否则 basis 是反射矩阵，不能转成 quaternion
    footprintRight.set(-footprintForward.z, 0, footprintForward.x);

    const material = new THREE.MeshBasicMaterial({
      map: shoe.tex,
      transparent: true,
      opacity: CFG.footprints.opacity,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(shoe.geo, material);
    mesh.position
      .copy(hero.position)
      .addScaledVector(footprintForward, -0.16)
      .addScaledVector(footprintRight, (nextFoot === 'left' ? -1 : 1) * CFG.footprints.side);
    mesh.position.y = 0.014;
    // 平面的局部 +Y 指向鞋尖、+Z 是法线，映射到前进方向和地面法线
    footprintBasis.makeBasis(footprintRight, footprintForward, footprintUp);
    mesh.quaternion.setFromRotationMatrix(footprintBasis);
    // 地板是不透明的，脚印得排在它后面画；相邻脚印重叠时也按生成顺序压
    mesh.renderOrder = 1;
    scene.add(mesh);
    footprints.push({ mesh, born: now });
    nextFoot = nextFoot === 'left' ? 'right' : 'left';
    if (footprints.length > CFG.footprints.max) removeFootprint(0);
  };

  /* ---------- 输入 ---------- */
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  let paused = false;
  let focused: Frame | null = null;
  let autoView: Frame | null = null;
  let focusSince = performance.now();
  /** 这一趟已经自动正对过的那幅画，走远（viewing.resetRange）才清掉 */
  let snapped: Frame | null = null;
  /** 正对之后用户自己转了镜头：这幅画在离开之前不再抢镜头 */
  let dismissed = false;

  const leaveAutoView = () => {
    autoView = null;
    focusSince = performance.now();
  };

  /** 用户自己转镜头。已经正对过一次的画就此作罢，走开再回来才重新接管 */
  const takeCamera = () => {
    if (snapped) dismissed = true;
    leaveAutoView();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // 别跟输入框、灯箱和浏览器快捷键抢按键
    const el = e.target as HTMLElement | null;
    if (paused || e.metaKey || e.ctrlKey || e.altKey) return;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (e.key === 'Enter' || e.code === 'Space') {
      if (focused) { e.preventDefault(); onEnter?.(focused.photo); }
      return;
    }
    if (/^(Key[WASD]|Arrow)/.test(e.code)) leaveAutoView();
    keys.add(e.code);
    // 方向键会滚动页面，展厅里它是走路
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // 拖动转视角。按下到抬起没怎么动，就当成「点这张画」
  let dragging = false;
  let dragged  = 0;
  let lastX = 0;
  const onPointerDown = (e: PointerEvent) => {
    takeCamera();
    dragging = true;
    dragged  = 0;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    dragged += Math.abs(dx);
    yaw -= dx * 0.005;
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    if (dragged > 6) return;
    // 点中哪张画就开哪张，不用非得走到跟前
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(frames.map(f => f.art), false)[0];
    if (hit) {
      const f = frames.find(x => x.art === hit.object);
      if (f) onEnter?.(f.photo);
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  const pointer = new THREE.Vector2();
  const ray = new THREE.Raycaster();

  /* ---------- 尺寸 ---------- */
  const resize = () => {
    const w = canvas.clientWidth  || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  /* ---------- 主循环 ---------- */
  let lastIndex = -1;
  let sinceSync = 0;
  // THREE.Clock 在 0.185 起已废弃，自己记上一帧的时间就够了
  let lastTime = performance.now();
  const camTarget = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  /**
   * 弹簧臂：从角色沿 (dx, dz) 往外最多能伸多长而不穿出展厅。
   * 墙挡住就缩短相机，而不是反过来把人挡在相机够得着的地方。
   */
  const armLength = (dx: number, dz: number): number => {
    let t = CFG.camera.dist;
    const until = (from: number, d: number, lo: number, hi: number) => {
      if (d >  1e-6) t = Math.min(t, (hi - from) / d);
      if (d < -1e-6) t = Math.min(t, (lo - from) / d);
    };
    until(hero.position.x, dx, -halfW + 0.45, halfW - 0.45);
    until(hero.position.z, dz, zFar + 0.45, zNear - 0.45);
    /*
     * 中庭的树和坐凳也要挡住相机：解一条从人出发、沿 (dx,dz) 的射线和圆的交点，
     * 撞上就把臂收到撞点之前。人已经站在圆里时收不出有意义的距离，直接跳过。
     */
    for (const b of blockers) {
      const fx = hero.position.x - b.x;
      const fz = hero.position.z - b.z;
      const rr = b.r + 0.3;
      const c = fx * fx + fz * fz - rr * rr;
      if (c <= 0) continue;
      const half = fx * dx + fz * dz;
      const disc = half * half - c;
      if (disc <= 0) continue;
      const hit = -half - Math.sqrt(disc);
      if (hit > 0) t = Math.min(t, hit);
    }
    return Math.max(0, t);
  };

  let bodyFade = 1;
  /** 角色整体淡出。0 全透明、1 不透明；影子跟着走，否则人没了地上还留一团黑 */
  const setBodyFade = (next: number) => {
    const to = THREE.MathUtils.clamp(next, 0, 1);
    if (Math.abs(to - bodyFade) < 0.004) return;
    bodyFade = to;
    const wantsBlend = to < 0.999;
    // transparent 进了 program cache key，真变了才标 needsUpdate，免得每帧重编译
    if (bodyMat.transparent !== wantsBlend) {
      bodyMat.transparent = wantsBlend;
      bodyMat.needsUpdate = true;
    }
    bodyMat.opacity = to;
    heroShadow.material.opacity = to;
  };
  const wish = new THREE.Vector3();
  /** 观赏机位那一档淡出的当前值，单独存一份才能平滑地进出剪影 */
  let viewFade = 1;
  let raf = 0;

  const tick = () => {
    raf = requestAnimationFrame(tick);
    // 切走再切回来会攒下一个很大的 delta，钳住免得角色瞬移穿墙
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    if (paused) return;

    /* 输入 → 期望速度（相对相机朝向） */
    let ix = stick.x;
    let iz = stick.y;
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  ix -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp'))    iz -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  iz += 1;
    const mag = Math.min(1, Math.hypot(ix, iz));
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = (running ? CFG.walk.run : CFG.walk.speed) * mag;

    if (mag > 0.001) {
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      /*
       * 相机在 hero + (sin·d, _, cos·d)，所以镜头前方 F = (-sin, 0, -cos)、
       * 右手方向 R = (cos, 0, -sin)。iz 是「按 W 为负」的轴，代进去展开即下式。
       */
      wish.set(ix * cos + iz * sin, 0, iz * cos - ix * sin).normalize().multiplyScalar(speed);
    } else {
      wish.set(0, 0, 0);
    }
    vel.lerp(wish, Math.min(1, CFG.walk.accel * dt));

    const oldX = hero.position.x;
    const oldZ = hero.position.z;
    hero.position.addScaledVector(vel, dt);
    // 碰撞就是把人夹在走廊里；画挂在墙上，留出 0.7m 不会把脸贴上去
    const limit = halfW - 0.7;
    hero.position.x = THREE.MathUtils.clamp(hero.position.x, -limit, limit);
    hero.position.z = THREE.MathUtils.clamp(hero.position.z, heroFront, heroBack);
    // 中庭的陈设：贴着圆心推出去，擦着走时不会卡住，正面撞上去就是沿墙滑开
    for (const b of blockers) {
      const bx = hero.position.x - b.x;
      const bz = hero.position.z - b.z;
      const min = b.r + 0.32;
      const d2 = bx * bx + bz * bz;
      if (d2 < 1e-6 || d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      hero.position.x = b.x + bx / d * min;
      hero.position.z = b.z + bz / d * min;
    }
    const moved = Math.hypot(hero.position.x - oldX, hero.position.z - oldZ);
    footprintDistance += moved;
    if (footprintDistance >= CFG.footprints.spacing) {
      footprintDistance %= CFG.footprints.spacing;
      leaveFootprint(now);
    }

    // 先保持一会儿，再线性淡出；过期 mesh 立即移出 scene，避免脚印越积越多。
    for (let i = footprints.length - 1; i >= 0; i--) {
      const fp = footprints[i];
      const age = now - fp.born;
      if (age >= CFG.footprints.holdMs + CFG.footprints.fadeMs) {
        removeFootprint(i);
      } else if (age > CFG.footprints.holdMs) {
        fp.mesh.material.opacity = CFG.footprints.opacity
          * (1 - (age - CFG.footprints.holdMs) / CFG.footprints.fadeMs);
      }
    }

    /* 朝向与步态 */
    const moving = vel.lengthSq() > 0.04;
    if (moving) {
      heading = Math.atan2(vel.x, vel.z);
      // 只要还在移动，2 秒停留计时就从头开始。
      leaveAutoView();
    } else if (autoView) {
      heading = Math.atan2(
        autoView.pos.x - hero.position.x,
        autoView.pos.z - hero.position.z
      );
    }
    // 走最短弧，从 -π 转到 π 时不会整个人原地绕一圈
    const turn = THREE.MathUtils.euclideanModulo(heading - hero.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    hero.rotation.y += turn * Math.min(1, CFG.walk.turn * dt);
    const targetGait = moving ? Math.min(1, vel.length() / CFG.walk.speed) : 0;
    gait += (targetGait - gait) * Math.min(1, 8 * dt);
    phase += vel.length() * dt * 2.6;
    animateBody(dt, phase, gait, vel.length());

    /* 相机跟随；观赏模式下相机退到人身后、抬过头顶，正对着画看。 */
    if (autoView) {
      // 画一律挂在左右墙上，法线永远沿 ±x：side -1 是左墙，正面朝 +x
      const nx = -autoView.side;
      const out = THREE.MathUtils.clamp(
        Math.abs(hero.position.x - autoView.pos.x) + CFG.viewing.back,
        CFG.viewing.minDist,
        CFG.viewing.maxDist
      );
      // 沿走廊和画心对齐，画才落在画面正中
      camTarget.set(autoView.pos.x + nx * out, CFG.viewing.height, autoView.pos.z);
      // 退出自动模式后手动镜头从当前方向接着走，不会突然跳回旧 yaw
      yaw = Math.atan2(camTarget.x - hero.position.x, camTarget.z - hero.position.z);
    } else {
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      const arm = armLength(dx, dz);
      camTarget.set(
        hero.position.x + dx * arm,
        CFG.camera.height,
        hero.position.z + dz * arm
      );
    }
    // 自动观赏机位不走弹簧臂（它是绕着画算的），这两条是它的兜底
    camTarget.x = THREE.MathUtils.clamp(camTarget.x, -halfW + 0.35, halfW - 0.35);
    camTarget.z = THREE.MathUtils.clamp(camTarget.z, zFar + 0.45, zNear - 0.45);
    camera.position.lerp(
      camTarget,
      Math.min(1, (autoView ? CFG.viewing.lerp : CFG.camera.lerp) * dt)
    );
    // 视线的 z 跟着相机走，方向就严格是墙面法线，画面不会被拍斜；转场途中也一直是正的
    if (autoView) lookAt.set(autoView.pos.x, autoView.pos.y, camera.position.z);
    else lookAt.set(hero.position.x, CFG.camera.lookY, hero.position.z);
    camera.lookAt(lookAt);

    // 相机被墙压到人身上时把角色淡掉。走到入口墙跟前读前言，挡在中间的就不该是后脑勺
    // 观赏机位下另淡一档：人就站在画前面，淡成剪影照片才完整露出来
    viewFade += ((autoView ? CFG.viewing.bodyFade : 1) - viewFade) * Math.min(1, 3 * dt);
    setBodyFade(Math.min(viewFade, (Math.hypot(
      camera.position.x - hero.position.x,
      camera.position.z - hero.position.z
    ) - 0.9) / 1.5));
    // 只跟一小段横向：补光贴到墙上会在画的旁边烧出一个亮斑，匀光的店堂里格外扎眼
    lamp.position.set(hero.position.x * 0.3, 3.4, hero.position.z);

    /*
     * 正在看哪张画：按视线角度 + 人到画的距离挑。
     * 自动观赏期间锁住不重算 —— 相机正朝那张转，转的过程里各张画的视线角度一直在变，
     * 重算会把自己甩掉，在相邻两张之间来回跳。
     */
    let best = autoView;
    let bestDist = 0;
    if (!best) {
      // 相机吊在 yaw 方向的后方看着角色，所以屏幕中心指向 (-sin, -cos)
      const vx = -Math.sin(yaw);
      const vz = -Math.cos(yaw);
      let bestScore = Infinity;
      for (const f of frames) {
        const dist = Math.hypot(f.pos.x - hero.position.x, f.pos.z - hero.position.z);
        if (dist > CFG.focus.range) continue;
        // 角度从相机量而不是从人量：紧挨着人 90° 的那张，在屏幕上其实是斜前方
        const cx = f.pos.x - camera.position.x;
        const cz = f.pos.z - camera.position.z;
        const cos = (cx * vx + cz * vz) / (Math.hypot(cx, cz) || 1);
        if (cos < CFG.focus.minCos) continue;
        const score = dist * (1 + CFG.focus.angleBias * (1 - cos));
        if (score < bestScore) { bestScore = score; best = f; bestDist = dist; }
      }
    }
    if (best !== focused) {
      focused?.group.scale.setScalar(1);
      focused = best;
      autoView = null;
      focusSince = now;
      onFocus?.(best ? best.photo : null);
    }
    // 走出这幅画的范围才算逛完；下次再走过来，自动正对重新生效
    if (snapped && Math.hypot(
      snapped.pos.x - hero.position.x, snapped.pos.z - hero.position.z
    ) > CFG.viewing.resetRange) {
      snapped = null;
      dismissed = false;
    }
    if (best && !moving && !dragging && !autoView
        && !(dismissed && best === snapped)
        && bestDist <= CFG.focus.turnRange
        && now - focusSince >= CFG.viewing.delayMs) {
      autoView = best;
      snapped = best;
      dismissed = false;
    }
    // 选中的那张微微凸出来，说明牌亮起时视线能对上是哪一幅
    if (focused) focused.group.scale.lerp(FOCUS_SCALE, Math.min(1, 8 * dt));
    const idx = best ? best.index + 1 : 0;
    if (idx !== lastIndex) { lastIndex = idx; onIndex?.(idx); }

    /* 纹理调度不用每帧跑 */
    sinceSync += dt;
    if (sinceSync > 0.25) { sinceSync = 0; syncTextures(hero.position); }

    renderer.render(scene, camera);
  };
  tick();

  /* ---------- 收尾 ---------- */
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach(x => {
          const withMap = x as THREE.MeshBasicMaterial;
          withMap.map?.dispose();
          x.dispose();
        });
      }
    });
    // 脚印可能已全部淡出并移出 scene，共享的 geometry / texture 碰不到上面的 traverse
    Object.values(stamp).forEach(s => { s?.geo.dispose(); s?.tex.dispose(); });
    envRT.dispose();
    mixer?.stopAllAction();
    figure?.dispose();
    renderer.dispose();
  };

  return {
    stop,
    setMove: (x, y) => {
      stick.x = x;
      stick.y = y;
      if (Math.hypot(x, y) > 0.05) leaveAutoView();
    },
    setPaused: (next) => {
      paused = next;
      // 暂停期间收不到 keyup，不清空的话回来时人会自己一直往前走
      if (next) { keys.clear(); stick.x = stick.y = 0; vel.set(0, 0, 0); }
    },
  };
}
