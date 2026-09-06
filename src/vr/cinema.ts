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
import { cloudinaryMaxVariant } from './source';

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
  screen:    { z: -10, y: 3.8, w: 12, h: 5.4 },
  photo:     { maxW: 11.2, maxH: 4.9 },
  zoomMax:   6,
  zoomSpeed: 1.5,
  hud:       { w: 8, y: 0.5, z: -9.4, tilt: -0.12 },
  exitHoldMs: 900,
  /** 画质相关 */
  // three 默认 foveation = 1（边缘低分辨率），银幕铺满视野时正好糊在边缘上，关掉
  foveation:   0,
  // 渲染分辨率倍率：不低于这个值，并尽量贴近头显原生分辨率（上限 2 防止过热掉帧）
  renderScale: 1.2,
  // 站点上的图是 w_1600，放在 VR 大银幕上像素不够；主图按最长边加载。
  photoSize:   4096,
  // q_auto 在大屏上压得太狠，明确给高质量
  quality:     90,
  // 放大超过这个倍数就后台换一张更高分辨率的，不然 6× 时只剩几百像素宽
  hiResFrom:   1.8,
  photoHiSize: 6144,
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

  const session = await navigator.xr!.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
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
  // 渲染分辨率取「不低于 renderScale」和「头显原生」里的较大者
  renderer.xr.setFramebufferScaleFactor(
    Math.min(2, Math.max(CFG.renderScale, nativeScaleOf(session)))
  );

  // local-floor 拿不到就退回 local，至少能进得去
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
  } catch {
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  }

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const maxTexSize = renderer.capabilities.maxTextureSize || CFG.photoSize;
  const vrSource = (src: string, size: number) =>
    cloudinaryMaxVariant(src, Math.min(size, maxTexSize), CFG.quality);

  /* ---------- 放映厅 ---------- */
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(CFG.room.w, CFG.room.h, CFG.room.d),
    new THREE.MeshStandardMaterial({ color: 0x121216, roughness: 1, metalness: 0, side: THREE.BackSide })
  );
  room.position.set(0, CFG.room.h / 2, -CFG.room.d / 2 + 8);
  scene.add(room);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.room.w, CFG.room.d),
    new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001, -CFG.room.d / 2 + 8);
  scene.add(floor);

  // 座椅只做空间参照，不需要精准
  const seatMat  = new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.9 });
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
    new THREE.PlaneGeometry(CFG.screen.w + 0.5, CFG.screen.h + 0.5),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  frame.position.set(0, CFG.screen.y, CFG.screen.z - 0.05);
  scene.add(frame);

  const border = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.screen.w + 0.9, CFG.screen.h + 0.9),
    new THREE.MeshBasicMaterial({ color: 0x1a1a1d })
  );
  border.position.set(0, CFG.screen.y, CFG.screen.z - 0.08);
  scene.add(border);

  // 1×1 的平面，靠 scale 适配各种宽高比
  const photoMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), photoMat);
  photo.position.set(0, CFG.screen.y, CFG.screen.z);
  photo.scale.set(CFG.photo.maxW, CFG.photo.maxH, 1);
  scene.add(photo);

  /* ---------- 银幕下方的信息条 ---------- */
  const hudCanvas  = document.createElement('canvas');
  hudCanvas.width  = 2048;
  hudCanvas.height = 256;
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
  };

  // 缩放时每帧都重画 canvas 太费，内容没变就跳过
  let hudKey = '';
  const drawHud = (note?: string) => {
    const key = `${index}|${Math.round(zoom * 100)}|${note ?? ''}`;
    if (key === hudKey) return;
    hudKey = key;
    const w = hudCanvas.width;
    hudCtx.clearRect(0, 0, w, hudCanvas.height);
    hudCtx.textAlign = 'center';
    hudCtx.fillStyle = 'rgba(255,255,255,0.9)';
    hudCtx.font = '600 62px system-ui, -apple-system, sans-serif';
    hudCtx.fillText(`${index + 1} / ${photos.length}　${photos[index].title}`, w / 2, 70);
    hudCtx.fillStyle = 'rgba(255,255,255,0.45)';
    hudCtx.font = '400 40px system-ui, -apple-system, sans-serif';
    const tip = note
      ?? (zoom > 1.01
        ? `已放大 ${Math.round(zoom * 100)}% · 扳机拖动 · 摇杆按下复位`
        : '摇杆上下 缩放 · 左右 翻页 · 扳机按住 拖动 · 摇杆按下 复位 · 长按侧键 退出');
    hudCtx.fillText(tip, w / 2, 150);
    hudTexture.needsUpdate = true;
  };

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  // 切图自增，异步回调靠它判断自己是不是过期了
  let token = 0;
  let hiResDone = false;

  const prepare = (tex: THREE.Texture) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.generateMipmaps = false;
    tex.minFilter  = THREE.LinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  };

  const showPhoto = (i: number) => {
    index = (i + photos.length) % photos.length;
    zoom = 1; offX = 0; offY = 0;
    hiResDone = false;
    const my = ++token;
    drawHud('载入中…');
    // VR 里用最长边高分辨率版本，站点那张 w_1600 在银幕上不够清晰
    loader.load(
      vrSource(photos[index].src, CFG.photoSize),
      tex => {
        if (disposed || my !== token) { tex.dispose(); return; }
        texture?.dispose();
        texture = prepare(tex);

        const img = tex.image as { width?: number; height?: number };
        const aspect = img?.width && img?.height ? img.width / img.height : 3 / 2;
        let w = CFG.photo.maxW;
        let h = w / aspect;
        if (h > CFG.photo.maxH) { h = CFG.photo.maxH; w = h * aspect; }
        photo.scale.set(w, h, 1);

        photoMat.map = tex;
        photoMat.color.set(0xffffff);
        photoMat.needsUpdate = true;
        apply();
        drawHud();
        picker.setPlaying(index);
        onIndex?.(index);
      },
      undefined,
      () => {
        if (disposed || my !== token) return;
        drawHud('这张图载入失败，摇杆左右换一张');
        onError?.(`VR 里载入失败：${photos[index].title}`);
      }
    );
  };

  /** 放大到一定程度后，后台换一张原尺寸的图；换完保持当前的缩放和平移 */
  const loadHiRes = () => {
    const my = token;
    loader.load(
      vrSource(photos[index].src, CFG.photoHiSize),
      tex => {
        if (disposed || my !== token) { tex.dispose(); return; }
        const cur = texture?.image as { width?: number } | undefined;
        const next = tex.image as { width?: number };
        // 原图还不如当前这张大（Cloudinary 不会放大超过原图），就没必要换
        if (cur?.width && next?.width && next.width <= cur.width) { tex.dispose(); return; }
        texture?.dispose();
        texture = prepare(tex);
        photoMat.map = tex;
        photoMat.needsUpdate = true;
        apply();
      },
      undefined,
      () => { /* 高清版没拿到就继续用当前这张 */ }
    );
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
  renderer.setAnimationLoop((_time, frame) => {
    if (!frame) return;
    const now = performance.now();
    const dt  = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    readInput(frame, now, dt);
    picker.update(dt);
    // 放大到一定程度就换更高分辨率的图，保证放大后还看得清细节
    if (!hiResDone && zoom > CFG.hiResFrom) {
      hiResDone = true;
      loadHiRes();
    }
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

  showPhoto(index);

  return {
    stop: () => {
      dispose();
      void session.end().catch(() => {});
    },
  };
}
