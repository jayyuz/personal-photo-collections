/**
 * picker — VR 里悬浮在空中的照片墙
 *
 * 照片排成一道圆弧「幕布」：顶行与视线齐平、其余各行往下排，
 * 选片时不用仰头；横向超出视野的部分靠左右拖动画布翻过来。
 * 摇杆缩放 = 换疏密（看到的张数变少、每张更大），而不是把整块布拉近拉远
 * —— 位置和尺寸一起缩放的话，视角大小其实是不变的。
 */
import * as THREE from 'three';
import { cloudinaryVariant } from './source';

export interface PickerPhoto {
  src: string;
  title: string;
}

export interface PickerOptions {
  photos:     PickerPhoto[];
  /** 幕布半径（米） */
  radius:     number;
  /** 幕布横向张开的弧度 */
  arcDeg:     number;
  /** 视高，顶行贴着它排 */
  eyeY:       number;
  /** 缩略图宽度与质量 */
  thumbWidth: number;
  quality:    number;
}

/** 疏密档位：越靠前每张越大、同时看到的越少 */
const DENSITIES = [
  { cols: 3, rows: 2 },
  { cols: 4, rows: 2 },
  { cols: 5, rows: 3 },
  { cols: 6, rows: 3 },
  { cols: 7, rows: 3 },
];

const MAX_DOWN_DEG = 34;   // 最下一行最多落在视线下方多少度
const HOVER_UP     = 0.09; // 悬停放大比例

interface Tile {
  group:  THREE.Group;
  img:    THREE.Mesh;
  imgMat: THREE.MeshBasicMaterial;
  bgMat:  THREE.MeshBasicMaterial;
  index:  number;
  hoverT: number;
}

export interface PickerHandle {
  group: THREE.Group;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  setPlaying(index: number): void;
  setHover(index: number | null): void;
  /** 跟着手拖动，单位是列（可为小数） */
  dragBy(columns: number): void;
  /** 松手后吸附到整列 */
  releaseDrag(): void;
  /** 整列翻页 */
  pageBy(columns: number): void;
  /** 换疏密：+1 变密（更小更多），-1 变疏（更大更少） */
  zoomBy(step: number): void;
  /** 射线指到哪张照片 */
  hitIndex(raycaster: THREE.Raycaster): number | null;
  /** 当前每列占多少度，拖动手感靠它换算 */
  columnStepDeg(): number;
  /** 当前一屏大致跨多少列，用于快速翻页 */
  pageStepColumns(): number;
  /** 布局状态有外部变更时强制刷新 */
  invalidate(): void;
  update(dt: number): void;
  dispose(): void;
}

export function createPicker(opts: PickerOptions): PickerHandle {
  const { photos, radius: R, arcDeg, eyeY, thumbWidth, quality } = opts;
  const total = photos.length;
  const group = new THREE.Group();

  const maxCols = Math.max(...DENSITIES.map(d => d.cols));
  const maxRows = Math.max(...DENSITIES.map(d => d.rows));
  const maxVisible = maxCols * maxRows;
  const maxCachedThumbs = maxVisible * 4;
  const maxPendingThumbs = maxVisible * 2;

  let density  = 2;
  let colOffset = 0;   // 连续值，拖动时跟着手
  let colTarget = 0;   // 吸附目标
  let hover: number | null = null;
  let playing  = 0;
  let open     = false;
  let openT    = 0;

  /* ---------- 缩略图 ---------- */
  const cache  = new Map<string, THREE.Texture>();
  const pending = new Set<string>();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  let protectedUrls = new Set<string>();

  const thumbUrl = (index: number) => cloudinaryVariant(photos[index].src, thumbWidth, quality);

  const touch = (url: string, tex: THREE.Texture) => {
    cache.delete(url);
    cache.set(url, tex);
  };

  const evictThumbs = () => {
    for (const [url, tex] of cache) {
      if (cache.size <= maxCachedThumbs) break;
      if (protectedUrls.has(url)) continue;
      cache.delete(url);
      tex.dispose();
    }
  };

  const thumbOf = (index: number): THREE.Texture | undefined => {
    const url = thumbUrl(index);
    const hit = cache.get(url);
    if (hit) {
      touch(url, hit);
      return hit;
    }
    if (pending.has(url) || pending.size >= maxPendingThumbs) return undefined;
    pending.add(url);
    loader.load(
      url,
      tex => {
        pending.delete(url);
        if (!cache.has(url)) {
          tex.colorSpace     = THREE.SRGBColorSpace;
          tex.generateMipmaps = false;
          tex.minFilter      = THREE.LinearFilter;
          tex.magFilter      = THREE.LinearFilter;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          cache.set(url, tex);
          evictThumbs();
        } else {
          tex.dispose();
        }
        dirty = true;
      },
      undefined,
      () => { pending.delete(url); }
    );
    return undefined;
  };

  /** 方格子：按 cover 的方式裁切，不留白边也不变形 */
  const fitSquare = (tex: THREE.Texture) => {
    const img = tex.image as { width?: number; height?: number };
    const aspect = img?.width && img?.height ? img.width / img.height : 1;
    if (aspect >= 1) {
      tex.repeat.set(1 / aspect, 1);
    } else {
      tex.repeat.set(1, aspect);
    }
    tex.offset.set((1 - tex.repeat.x) / 2, (1 - tex.repeat.y) / 2);
  };

  /* ---------- 格子池 ---------- */
  const quad = new THREE.PlaneGeometry(1, 1);
  const tiles: Tile[] = [];
  const imgMeshes: THREE.Mesh[] = [];

  for (let i = 0; i < maxCols * maxRows; i++) {
    const imgMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bgMat  = new THREE.MeshBasicMaterial({ color: 0x0a0a0c });
    const img    = new THREE.Mesh(quad, imgMat);
    const bg     = new THREE.Mesh(quad, bgMat);
    bg.position.z = -0.004;
    img.userData.slot = i;
    const g = new THREE.Group();
    g.add(bg, img);
    g.visible = false;
    group.add(g);
    tiles.push({ group: g, img, imgMat, bgMat, index: -1, hoverT: 0 });
    imgMeshes.push(img);
  }

  /* ---------- 幕布上方的说明条 ---------- */
  const infoCanvas  = document.createElement('canvas');
  infoCanvas.width  = 1024;
  infoCanvas.height = 192;
  const infoCtx     = infoCanvas.getContext('2d')!;
  const infoTex     = new THREE.CanvasTexture(infoCanvas);
  infoTex.colorSpace = THREE.SRGBColorSpace;
  const infoMat  = new THREE.MeshBasicMaterial({ map: infoTex, transparent: true });
  const infoMesh = new THREE.Mesh(quad, infoMat);
  group.add(infoMesh);
  let infoKey = '';

  const drawInfo = () => {
    const { cols } = DENSITIES[density];
    const from = Math.round(colOffset) * DENSITIES[density].rows + 1;
    const key = `${playing}|${hover}|${from}|${cols}`;
    if (key === infoKey) return;
    infoKey = key;
    const w = infoCanvas.width;
    infoCtx.clearRect(0, 0, w, infoCanvas.height);
    infoCtx.textAlign = 'center';
    infoCtx.fillStyle = 'rgba(255,255,255,0.9)';
    infoCtx.font = '600 58px system-ui, -apple-system, sans-serif';
    infoCtx.fillText(
      hover !== null && hover >= 0
        ? photos[hover].title
        : `共 ${total} 张 · 正在播放第 ${playing + 1} 张`,
      w / 2, 68
    );
    infoCtx.fillStyle = 'rgba(255,255,255,0.42)';
    infoCtx.font = '400 36px system-ui, -apple-system, sans-serif';
    infoCtx.fillText('指向照片扣扳机播放 · 按住扳机左右拖动画布 · 摇杆缩放', w / 2, 128);
    infoTex.needsUpdate = true;
  };

  /* ---------- 布局 ---------- */
  const maxColOffset = () => {
    const { cols, rows } = DENSITIES[density];
    return Math.max(0, Math.ceil(total / rows) - cols);
  };

  let dirty = true;

  const layout = () => {
    const { cols, rows } = DENSITIES[density];
    const colStepDeg = arcDeg / cols;
    const colStepRad = THREE.MathUtils.degToRad(colStepDeg);
    const wByCol  = R * colStepRad * 0.86;
    const vBudget = R * Math.tan(THREE.MathUtils.degToRad(MAX_DOWN_DEG));
    const hByRow  = (vBudget / (rows + 0.4)) * 0.92;
    const tile    = Math.min(wByCol, hByRow);
    const rowStep = tile * 1.14;
    const topY    = eyeY - tile * 0.5;

    infoMesh.position.set(0, topY + tile * 0.5 + 0.34, -R * 0.99);
    infoMesh.scale.set(Math.min(2.6, R * 0.9), Math.min(2.6, R * 0.9) * 0.1875, 1);
    infoMesh.rotation.x = -0.06;

    const firstCol = Math.round(colOffset);
    const nextProtected = new Set<string>();
    for (let slot = 0; slot < tiles.length; slot++) {
      const t = tiles[slot];
      const c = firstCol + (slot % cols);
      const r = Math.floor(slot / cols);
      const index = c * rows + r;

      if (slot >= cols * rows || c < 0 || index >= total) {
        t.group.visible = false;
        t.index = -1;
        t.imgMat.map = null;
        continue;
      }

      nextProtected.add(thumbUrl(index));
      const ang = ((c - colOffset) - (cols - 1) / 2) * colStepRad;
      t.group.position.set(R * Math.sin(ang), topY - r * rowStep, -R * Math.cos(ang));
      t.group.rotation.y = -ang;
      t.group.visible = true;
      t.index = index;

      t.img.scale.set(tile, tile, 1);
      t.img.position.z = 0;
      (t.group.children[0] as THREE.Mesh).scale.set(tile * 1.16, tile * 1.16, 1);

      const tex = thumbOf(index);
      if (tex && t.imgMat.map !== tex) {
        fitSquare(tex);
        t.imgMat.map = tex;
        t.imgMat.color.set(0xffffff);
        t.imgMat.needsUpdate = true;
      } else if (!tex) {
        t.imgMat.map = null;
        t.imgMat.color.set(0x1b1b1f);
        t.imgMat.needsUpdate = true;
      } else {
        t.imgMat.color.set(0xffffff);
      }
    }
    protectedUrls = nextProtected;
    evictThumbs();
  };

  /* ---------- 对外接口 ---------- */
  const clampOffset = (v: number) => Math.min(maxColOffset() + 0.5, Math.max(-0.5, v));

  const handle: PickerHandle = {
    group,
    isOpen: () => open,
    setOpen: (v: boolean) => {
      open = v;
      if (v) {
        // 打开时把正在播放的那张摆到中间
        const { cols, rows } = DENSITIES[density];
        colOffset = clampOffset(Math.floor(playing / rows) - Math.floor((cols - 1) / 2));
        colTarget = Math.round(colOffset);
        dirty = true;
      } else {
        hover = null;
      }
    },
    setPlaying: (i: number) => { playing = i; },
    setHover: (i: number | null) => { hover = i; },
    dragBy: (d: number) => {
      colOffset = clampOffset(colOffset + d);
      colTarget = Math.round(colOffset);
      dirty = true;
    },
    releaseDrag: () => {
      colTarget = Math.min(maxColOffset(), Math.max(0, Math.round(colOffset)));
    },
    pageBy: (d: number) => {
      colTarget = Math.min(maxColOffset(), Math.max(0, Math.round(colTarget) + d));
    },
    zoomBy: (step: number) => {
      const next = Math.min(DENSITIES.length - 1, Math.max(0, density + step));
      if (next === density) return;
      density = next;
      colOffset = clampOffset(colOffset);
      colTarget = Math.min(maxColOffset(), Math.max(0, Math.round(colOffset)));
      dirty = true;
    },
    hitIndex: (raycaster) => {
      const hit = raycaster.intersectObjects(imgMeshes, false)[0];
      if (!hit) return null;
      const slot = (hit.object.userData.slot as number) ?? -1;
      const t = tiles[slot];
      return t && t.group.visible && t.index >= 0 ? t.index : null;
    },
    columnStepDeg: () => arcDeg / DENSITIES[density].cols,
    pageStepColumns: () => Math.max(1, DENSITIES[density].cols - 1),
    invalidate: () => {
      dirty = true;
      infoKey = '';
    },
    update: (dt: number) => {
      openT += ((open ? 1 : 0) - openT) * Math.min(1, dt * 12);
      group.visible = openT > 0.01;
      if (!group.visible) return;
      group.scale.setScalar(0.94 + 0.06 * openT);

      if (Math.abs(colOffset - colTarget) > 0.001) {
        colOffset += (colTarget - colOffset) * Math.min(1, dt * 10);
        dirty = true;
      }
      if (dirty) { dirty = false; layout(); }

      for (const t of tiles) {
        const want = t.index >= 0 && t.index === hover ? 1 : 0;
        if (Math.abs(t.hoverT - want) > 0.001) {
          t.hoverT += (want - t.hoverT) * Math.min(1, dt * 14);
          t.group.scale.setScalar(1 + HOVER_UP * t.hoverT);
        }
        // 黑边：悬停变白、正在播放的描一圈蓝
        if (t.index >= 0) {
          if (t.index === hover) t.bgMat.color.setHex(0xffffff);
          else if (t.index === playing) t.bgMat.color.setHex(0x3d6bff);
          else t.bgMat.color.setHex(0x0a0a0c);
        }
      }
      drawInfo();
    },
    dispose: () => {
      quad.dispose();
      for (const t of tiles) { t.imgMat.dispose(); t.bgMat.dispose(); }
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
      pending.clear();
      infoTex.dispose();
      infoMat.dispose();
    },
  };

  return handle;
}
