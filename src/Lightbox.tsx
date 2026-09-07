import { useState, useEffect, useRef, useCallback } from 'react';
import type { Photo, PhotoExif } from './data';
import { exifRows, readExifFromUrl } from './exif';
import { cardGeometry } from './PhotoCard';
import type { CardGeometry } from './PhotoCard';
import type { CinemaHandle } from './vr/cinema';

interface LightboxProps {
  photo: Photo | null;
  /** VR 里翻页用：当前展示顺序下的全部照片 */
  photos: Photo[];
  onSelect: (index: number) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

/** 用 Cloudinary 生成一张极小的模糊图，做背景比在前端 blur 大图省得多 */
function backdropUrl(src: string): string {
  if (!src.includes('res.cloudinary.com')) return src;
  return src.replace(/\/upload\/[^/]*\//, '/upload/w_120,e_blur:1200,q_30,f_auto/');
}

const MAX_ZOOM = 6;
const FIT = { s: 1, x: 0, y: 0 };
/** 从卡片放大到全屏（以及关闭时飞回去）的时长 */
const FLIP_MS = 380;
const FLIP_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** 大图圆角，飞行结束时要正好落在 .lb__img 的圆角上 */
const IMG_RADIUS = 5;
/** 缩不回卡片时的整块淡出，要和 .lb--fade 的过渡对齐 */
const EXIT_FADE_MS = 220;
/** 滑动超过这个距离（或屏宽的 16%）就翻页 */
const SWIPE_MIN = 48;
/** 单指移动超过这个距离就不算点击，免得滑一下把信息层切出来 */
const TAP_SLOP = 6;

interface View { s: number; x: number; y: number }

const reduceMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const onScreen = (r: DOMRect) =>
  r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;

interface Gesture {
  mode: 'idle' | 'pan' | 'pinch' | 'swipe';
  /** 单指起点或双指中心起点 */
  startX: number;
  startY: number;
  startDist:  number;
  startScale: number;
  startView:  View;
  moved: number;
  dx: number;
  dy: number;
}

export function Lightbox({
  photo, photos, onSelect, onClose, onPrev, onNext, hasPrev, hasNext,
}: LightboxProps) {
  const [loaded, setLoaded] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [liveExif, setLiveExif] = useState<PhotoExif | undefined>();
  const [exifState, setExifState] = useState<'idle' | 'loading' | 'ok' | 'none'>('idle');
  const [view, setView] = useState<View>(FIT);
  const [gesturing, setGesturing] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const [flipping, setFlipping] = useState(false);
  /** 退场方式：缩回卡片，或者找不到卡片时整块淡出 */
  const [exit, setExit] = useState<'flip' | 'fade' | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);
  const movedRef = useRef(0);
  const flipRef = useRef<Animation | null>(null);
  const exitTimerRef = useRef(0);
  const openedRef = useRef(false);
  const pendingFlipRef = useRef<{ geo: CardGeometry; at: number } | null>(null);
  // 手势过程中要读最新 view，用 ref 镜像一份，免得闭包拿到旧值
  const viewRefState = useRef<View>(view);

  useEffect(() => { viewRefState.current = view; }, [view]);

  useEffect(() => { setLoaded(false); setView(FIT); setSwipe(0); }, [photo?.id]);

  /** 平移不能把图片拖出可视区之外 */
  const clampOffset = useCallback((s: number, x: number, y: number) => {
    const box = viewRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    if (!box || !img) return { x, y };
    const mx = Math.max(0, (img.offsetWidth * s - box.width) / 2);
    const my = Math.max(0, (img.offsetHeight * s - box.height) / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  }, []);

  /** 以光标所在点为锚点缩放，指到哪放大哪 */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView(v => {
      const s = Math.min(MAX_ZOOM, Math.max(1, v.s * factor));
      if (s === v.s) return v;
      if (s === 1) return FIT;
      const box = viewRef.current?.getBoundingClientRect();
      if (!box) return { ...v, s };
      const px = cx - (box.left + box.width / 2);
      const py = cy - (box.top + box.height / 2);
      const k = s / v.s;
      return { s, ...clampOffset(s, px - (px - v.x) * k, py - (py - v.y) * k) };
    });
  }, [clampOffset]);

  // React 的 onWheel 是被动监听，拦不掉页面滚动，只能自己挂非被动监听
  useEffect(() => {
    const el = viewRef.current;
    if (!el || !photo) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // ctrlKey 代表触控板捏合，步进要更灵敏
      zoomAt(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [photo, zoomAt]);

  useEffect(() => {
    if (!photo) {
      setLiveExif(undefined);
      setExifState('idle');
      return;
    }
    if (photo.exif) {
      setLiveExif(photo.exif);
      setExifState('ok');
      return;
    }
    let cancelled = false;
    setLiveExif(undefined);
    setExifState('loading');
    void readExifFromUrl(photo.src).then(parsed => {
      if (cancelled) return;
      setLiveExif(parsed);
      setExifState(parsed ? 'ok' : 'none');
    });
    return () => { cancelled = true; };
  }, [photo?.id, photo?.src, photo?.exif]);

  /* ---------- 从卡片放大 / 缩回卡片 ---------- */

  /**
   * 让大图在「卡片里那一格」和「铺开后的位置」之间飞一趟。
   * 卡片里的图是 cover 裁切的：先把它在卡片里铺开的真实大小算出来当起点缩放（等比，不然画面会变形），
   * 再用 clip-path 把可视范围裁成卡片那个窗口，起点看上去就跟卡片里的画面严丝合缝。
   */
  const runFlip = useCallback((geo: CardGeometry, dir: 'in' | 'out', done?: () => void) => {
    const img = imgRef.current;
    const w = img?.offsetWidth  ?? 0;
    const h = img?.offsetHeight ?? 0;
    if (!img || !w || !h || typeof img.animate !== 'function') { done?.(); return; }

    // getBoundingClientRect 拿到的是带 transform 的，反推出没有 transform 时的中心
    const box = img.getBoundingClientRect();
    const v = viewRefState.current;
    const cx = box.left + box.width  / 2 - v.x;
    const cy = box.top  + box.height / 2 - v.y;

    // cover：画面等比放大到刚好盖住卡片那个盒子，两边总有一个方向要溢出
    const cw = Math.max(geo.box.width, geo.box.height * (w / h));
    const ch = cw * (h / w);
    const s  = cw / w;
    const bx = geo.box.left + geo.box.width  / 2;
    const by = geo.box.top  + geo.box.height / 2;
    // 卡片窗口换算回图片自身的坐标系，就是起点该裁掉多少
    const l = (geo.frame.left - (bx - cw / 2)) / s;
    const t = (geo.frame.top  - (by - ch / 2)) / s;
    const crop = [
      Math.max(0, t),
      Math.max(0, w - l - geo.frame.width  / s),
      Math.max(0, h - t - geo.frame.height / s),
      Math.max(0, l),
    ].map(n => `${n}px`).join(' ');
    const atCard: Keyframe = {
      transform: `translate3d(${bx - cx}px, ${by - cy}px, 0) scale(${s})`,
      clipPath: `inset(${crop} round 0px)`,
      opacity: 1,
    };
    const atFull: Keyframe = {
      transform: 'translate3d(0px, 0px, 0) scale(1)',
      clipPath: `inset(0px 0px 0px 0px round ${IMG_RADIUS}px)`,
      opacity: 1,
    };

    flipRef.current?.cancel();
    const anim = img.animate(dir === 'in' ? [atCard, atFull] : [atFull, atCard], {
      duration: FLIP_MS,
      easing: FLIP_EASE,
      // 飞回卡片时要停在终点等着卸载，不然会闪回全屏一帧
      fill: dir === 'out' ? 'forwards' : 'none',
    });
    flipRef.current = anim;
    setFlipping(true);
    // 缩回卡片那一趟要一直停在终点，所以只有飞入结束才把飞行状态摘掉
    const settle = () => { if (dir === 'in') setFlipping(false); };
    anim.addEventListener('finish', () => { settle(); done?.(); });
    anim.addEventListener('cancel', settle);
  }, []);

  // photo 从空变成有值才算一次「打开」，同一次打开里左右翻页不再飞
  useEffect(() => {
    if (!photo) {
      openedRef.current = false;
      pendingFlipRef.current = null;
      flipRef.current = null;
      window.clearTimeout(exitTimerRef.current);
      setFlipping(false);
      setExit(null);
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    const geo = reduceMotion() ? null : cardGeometry(photo.id);
    pendingFlipRef.current = geo ? { geo, at: performance.now() } : null;
    // 缓存里的图有可能不再触发 onLoad，自己问一声
    if (imgRef.current?.complete) setLoaded(true);
  }, [photo]);

  // 要等图片有尺寸了才能算终点，所以放在 loaded 之后
  useEffect(() => {
    if (!loaded) return;
    const p = pendingFlipRef.current;
    pendingFlipRef.current = null;
    // 图没缓存、加载等了半天才好的话就别飞了，那会儿飞反而显得莫名其妙
    if (!p || performance.now() - p.at > 500) return;
    runFlip(p.geo, 'in');
  }, [loaded, runFlip]);

  /** 关闭时先缩回原来的卡片，动画放完再真的卸载 */
  const requestClose = useCallback(() => {
    if (exit) return;
    if (!photo || reduceMotion()) { onClose(); return; }
    // 放大看细节时缩回去没什么意义；卡片被滑出可视区（比如在 VR 里翻了很多张）也没地方可缩
    const geo = viewRefState.current.s === 1 ? cardGeometry(photo.id) : null;
    if (geo && onScreen(geo.frame)) {
      setExit('flip');
      runFlip(geo, 'out', onClose);
      return;
    }
    setExit('fade');
    exitTimerRef.current = window.setTimeout(onClose, EXIT_FADE_MS);
  }, [exit, photo, onClose, runFlip]);

  useEffect(() => () => {
    flipRef.current?.cancel();
    window.clearTimeout(exitTimerRef.current);
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (!photo) return;
      if (e.key === 'Escape') {
        if (view.s > 1) setView(FIT);
        else requestClose();
      }
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [photo, requestClose, onPrev, onNext, hasPrev, hasNext, view.s]);

  useEffect(() => {
    document.body.style.overflow = photo ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [photo]);

  /* ---------- VR 影院 ---------- */
  const [vrReady, setVrReady] = useState(false);
  const [vrBusy,  setVrBusy]  = useState(false);
  const [vrNote,  setVrNote]  = useState('');
  const cinemaRef = useRef<CinemaHandle | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = navigator.xr
        ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
        : false;
      if (alive) setVrReady(ok);
    })();
    return () => { alive = false; };
  }, []);

  // 关灯箱时顺手把 VR 会话收掉
  useEffect(() => () => cinemaRef.current?.stop(), []);

  const enterVr = async () => {
    if (vrBusy || cinemaRef.current) return;
    setVrBusy(true);
    setVrNote('正在进入 VR…');
    try {
      const mod   = await import('./vr/cinema');
      const start = Math.max(0, photos.findIndex(p => p.id === photo?.id));
      cinemaRef.current = await mod.startCinema({
        photos:  photos.map(p => ({ src: p.src, title: p.title })),
        start,
        onIndex: onSelect,
        onExit:  () => { cinemaRef.current = null; setVrNote(''); },
        onError: setVrNote,
      });
      setVrNote('');
    } catch (e) {
      setVrNote(String(e instanceof Error ? e.message : e) || '进入 VR 失败');
    } finally {
      setVrBusy(false);
    }
  };

  const centerOf = (pts: { x: number; y: number }[]) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  });

  /** 视口中心，缩放锚点和位移都以它为原点 */
  const boxCenter = () => {
    const box = viewRef.current?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // 按钮上的按下交给按钮自己处理
    if (e.target instanceof Element && e.target.closest('button')) return;
    // 放大动画还没放完就上手了，让手势接管，免得动画结束时画面跳一下
    if (!exit) { flipRef.current?.cancel(); flipRef.current = null; }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointersRef.current.values()];
    const base = viewRefState.current;
    movedRef.current = pts.length >= 2 ? TAP_SLOP + 1 : 0;

    if (pts.length >= 2) {
      const c = centerOf(pts.slice(0, 2));
      gestureRef.current = {
        mode: 'pinch',
        startX: c.x, startY: c.y,
        startDist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        startScale: base.s,
        startView:  base,
        moved: TAP_SLOP + 1, dx: 0, dy: 0,
      };
      setSwipe(0);
      setGesturing(true);
      return;
    }

    gestureRef.current = {
      mode: 'idle',
      startX: e.clientX, startY: e.clientY,
      startDist: 0, startScale: base.s, startView: base,
      moved: 0, dx: 0, dy: 0,
    };
    if (base.s > 1) setGesturing(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || !pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointersRef.current.values()];

    if (g.mode === 'pinch' && pts.length >= 2) {
      const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const c = centerOf(pts.slice(0, 2));
      const L  = boxCenter();
      const s  = Math.min(MAX_ZOOM, Math.max(1, g.startScale * (dist / g.startDist)));
      if (s === 1) { setView(FIT); return; }
      // 捏合开始时双指中心压着的那个内容点，跟着手指走：缩放的同时也能平移
      const ux = (g.startX - L.x - g.startView.x) / g.startScale;
      const uy = (g.startY - L.y - g.startView.y) / g.startScale;
      setView({ s, ...clampOffset(s, (c.x - L.x) - s * ux, (c.y - L.y) - s * uy) });
      return;
    }

    if (pts.length >= 2) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    g.dx = dx;
    g.dy = dy;
    g.moved = Math.abs(dx) + Math.abs(dy);

    // 放大状态下单指拖动就是平移
    if (g.startView.s > 1) {
      g.mode = 'pan';
      setView({
        s: g.startView.s,
        ...clampOffset(g.startView.s, g.startView.x + dx, g.startView.y + dy),
      });
      return;
    }

    // 没放大时横向滑动翻页；鼠标拖拽不做翻页
    if (e.pointerType !== 'mouse' && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      g.mode = 'swipe';
      setGesturing(true);
      setSwipe(dx * 0.45);
    }
  };

  const endGesture = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    pointersRef.current.delete(e.pointerId);
    const pts = [...pointersRef.current.values()];

    if (g.mode === 'swipe') {
      const box = viewRef.current?.getBoundingClientRect();
      const threshold = Math.max(SWIPE_MIN, (box?.width ?? 320) * 0.16);
      setSwipe(0);
      if (g.dx <= -threshold && hasNext) onNext();
      else if (g.dx >= threshold && hasPrev) onPrev();
    }
    movedRef.current = g.moved;

    if (pts.length > 0) {
      // 捏合时抬起一根手指：以剩下那根（或剩下的两根）为起点接着来，避免画面跳一下
      const base = viewRefState.current;
      const two = pts.length >= 2;
      const c = two ? centerOf(pts.slice(0, 2)) : pts[0];
      gestureRef.current = {
        mode: two ? 'pinch' : base.s > 1 ? 'pan' : 'idle',
        startX: c.x, startY: c.y,
        startDist: two ? Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) : 0,
        startScale: base.s, startView: base,
        moved: TAP_SLOP + 1, dx: 0, dy: 0,
      };
      return;
    }

    gestureRef.current = null;
    setGesturing(false);
  };

  // 拖动平移之后不该顺手把信息层切掉
  const toggleInfo = () => {
    if (movedRef.current > TAP_SLOP) return;
    setInfoOpen(o => !o);
  };

  if (!photo) return null;

  const rows = liveExif ? exifRows(liveExif) : [];
  const zoomed = view.s > 1;

  return (
    <div
      className={[
        'lb',
        zoomed ? 'lb--zoom' : '',
        infoOpen ? 'lb--info' : '',
        exit === 'flip' ? 'lb--closing' : '',
        exit === 'fade' ? 'lb--fade' : '',
      ].filter(Boolean).join(' ')}
      role="dialog"
      aria-modal="true"
      aria-label={photo.title}
    >
      <div className="lb__backdrop" aria-hidden="true">
        <img key={`bd-${photo.id}`} src={backdropUrl(photo.src)} alt="" className="lb__backdrop-img" />
        <div className="lb__backdrop-veil" />
      </div>
      <div
        ref={viewRef}
        className="lb__view"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onClick={(e) => {
          // 滑动过就别顺手关掉，movedRef 在 pointerup 时已经写好
          if (e.target === e.currentTarget && movedRef.current <= TAP_SLOP) requestClose();
        }}
      >
        <button className="lb__close" onClick={requestClose} aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        {!infoOpen && (
          <button className="lb__info-btn" onClick={() => setInfoOpen(true)} aria-label="显示拍摄信息">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12" y2="8" />
            </svg>
          </button>
        )}
        {vrReady && (
          <button
            className="lb__vr"
            onClick={() => void enterVr()}
            disabled={vrBusy}
            aria-label="进入 VR 影院观看"
            title="进入 VR 影院（Pico 等支持 WebXR 的设备）"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.6 9.4a2.4 2.4 0 0 1 2.4-2.4h14a2.4 2.4 0 0 1 2.4 2.4v2.2a4.4 4.4 0 0 1-4.4 4.4h-.9l-1.4 2.2H9.3L7.9 16h-.9a4.4 4.4 0 0 1-4.4-4.4z" />
              <circle cx="8.4" cy="10.6" r="1.7" />
              <circle cx="15.6" cy="10.6" r="1.7" />
            </svg>
          </button>
        )}
        <div className="lb__stage">
          {!loaded && <div className="lb__placeholder" />}
          <img
            ref={imgRef}
            key={photo.id}
            src={photo.src}
            alt={photo.title}
            draggable={false}
            className={[
              'lb__img',
              loaded ? 'lb__img--on' : '',
              zoomed ? 'lb__img--zoomed' : '',
              gesturing ? 'lb__img--live' : '',
              flipping ? 'lb__img--flip' : '',
            ].filter(Boolean).join(' ')}
            style={{
              transform:
                `translate3d(${view.x + swipe}px, ${view.y}px, 0) ` +
                `scale(${view.s * (loaded ? 1 : 0.985)})`,
            }}
            onLoad={() => setLoaded(true)}
            onClick={toggleInfo}
          />
        </div>
        {zoomed && (
          <div className="lb__zoom">
            <span>{Math.round(view.s * 100)}%</span>
            <button onClick={() => setView(FIT)}>复位</button>
          </div>
        )}
        {hasPrev && (
          <button className="lb__nav lb__nav--prev" onClick={onPrev} aria-label="上一张">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        {hasNext && (
          <button className="lb__nav lb__nav--next" onClick={onNext} aria-label="下一张">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      {vrNote && <p className="lb__vr-note">{vrNote}</p>}

      {infoOpen && (
        <aside className="lb__panel" aria-label="拍摄信息">
          <div className="lb__panel-head">
            <span className="lb__panel-kicker">拍摄信息</span>
            <button className="lb__panel-hide" onClick={() => setInfoOpen(false)} aria-label="收起拍摄信息">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="lb__panel-body">
            <h2 className="lb__panel-title">{photo.title}</h2>
            {(photo.location || photo.year) && (
              <p className="lb__panel-sub">
                {[photo.location, photo.year].filter(Boolean).join(' · ')}
              </p>
            )}
            {exifState === 'loading' ? (
              <p className="lb__exif-empty">正在从图片读取拍摄参数…</p>
            ) : rows.length > 0 ? (
              <dl className="lb__exif">
                {rows.map(r => (
                  <div key={r.label} className="lb__exif-row">
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="lb__exif-empty">
                这张网络图片里读不到 EXIF。Cloudinary 默认会剥掉元数据。
                本地上传原图最稳；已有图可在 Upload Preset 勾选 Keep IPTC / EXIF，
                或在配置里填 API Key / Secret 用 Admin API 读取。
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
