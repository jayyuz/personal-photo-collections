/**
 * cinema — WebXR 影院模式
 *
 * 观众站在放映厅中央，正前方是一块大银幕；用 Pico 手柄（xr-standard 映射）看片：
 *   摇杆上下  缩放（以射线指向的位置为锚点）
 *   摇杆左右  上一张 / 下一张
 *   扳机按住  按住并移动手柄平移画面
 *   摇杆按下  复位
 *   长按侧键  退出 VR
 *
 * 缩放不是放大几何体，而是改纹理的 repeat / offset ——
 * 银幕大小恒定，画面在里面放大缩小，才是「在看一张照片」而不是「照片扑面而来」。
 */
import * as THREE from 'three';

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
};

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

  // local-floor 拿不到就退回 local，至少能进得去
  try {
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
  } catch {
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  }

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

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

  const showPhoto = (i: number) => {
    index = (i + photos.length) % photos.length;
    zoom = 1; offX = 0; offY = 0;
    drawHud('载入中…');
    const url = photos[index].src;
    loader.load(
      url,
      tex => {
        if (disposed || url !== photos[index].src) { tex.dispose(); return; }
        tex.colorSpace  = THREE.SRGBColorSpace;
        tex.anisotropy  = maxAniso;
        tex.minFilter   = THREE.LinearMipmapLinearFilter;
        tex.magFilter   = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        texture?.dispose();
        texture = tex;

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
        onIndex?.(index);
      },
      undefined,
      () => {
        if (disposed) return;
        drawHud('这张图载入失败，摇杆左右换一张');
        onError?.(`VR 里载入失败：${photos[index].title}`);
      }
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

  /* ---------- 射线拾取：手柄指向银幕上的哪一点 ---------- */
  const raycaster = new THREE.Raycaster();
  const tmpMat = new THREE.Matrix4();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const screenUv = (src: XRInputSource, frame: XRFrame): THREE.Vector2 | null => {
    const space = renderer.xr.getReferenceSpace();
    if (!space || !src.targetRaySpace) return null;
    const pose = frame.getPose(src.targetRaySpace, space);
    if (!pose) return null;
    tmpMat.fromArray(pose.transform.matrix);
    origin.setFromMatrixPosition(tmpMat);
    // 方向向量只吃旋转，不能用 applyMatrix4（会把平移也算进去）
    dir.set(0, 0, -1).transformDirection(tmpMat);
    raycaster.set(origin, dir);
    const hit = raycaster.intersectObject(photo, false)[0];
    return hit?.uv ? hit.uv.clone() : null;
  };

  /* ---------- 手柄状态 ---------- */
  interface CtrlState {
    prev: boolean[];
    latch: boolean;
    gripAt: number | null;
    drag: { u: number; v: number } | null;
  }
  const states = new Map<XRInputSource, CtrlState>();
  const stateOf = (src: XRInputSource): CtrlState => {
    let s = states.get(src);
    if (!s) { s = { prev: [], latch: false, gripAt: null, drag: null }; states.set(src, s); }
    return s;
  };

  let last = performance.now();

  const readInput = (frame: XRFrame, now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const st = stateOf(src);
      const { x: ax, y: ay } = stickAxes(gp as Gamepad);

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
      const trigger = gp.buttons[0]?.pressed ?? false;
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
      if ((gp.buttons[4]?.pressed ?? false) && !st.prev[4]) showPhoto(index - 1);
      if ((gp.buttons[5]?.pressed ?? false) && !st.prev[5]) showPhoto(index + 1);

      // 长按侧键退出
      const grip = gp.buttons[1]?.pressed ?? false;
      if (grip && st.gripAt === null) st.gripAt = now;
      if (!grip) st.gripAt = null;
      if (grip && st.gripAt !== null && now - st.gripAt > CFG.exitHoldMs) {
        pulse(gp as Gamepad, 1, 120);
        void session.end();
        return;
      }

      st.prev = gp.buttons.map(b => b.pressed);
    }
  };

  /* ---------- 主循环 ---------- */
  renderer.setAnimationLoop((_time, frame) => {
    if (!frame) return;
    const now = performance.now();
    readInput(frame, now);
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
