import { useState, useEffect, useRef, useCallback } from 'react';
import type { Photo, PhotoExif } from './data';
import { exifRows, readExifFromUrl } from './exif';

interface LightboxProps {
  photo: Photo | null;
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

export function Lightbox({ photo, onClose, onPrev, onNext, hasPrev, hasNext }: LightboxProps) {
  const [loaded, setLoaded] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [liveExif, setLiveExif] = useState<PhotoExif | undefined>();
  const [exifState, setExifState] = useState<'idle' | 'loading' | 'ok' | 'none'>('idle');
  const [view, setView] = useState(FIT);
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  const movedRef = useRef(0);

  useEffect(() => { setLoaded(false); setView(FIT); }, [photo?.id]);

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

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (!photo) return;
      if (e.key === 'Escape') {
        if (view.s > 1) setView(FIT);
        else onClose();
      }
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [photo, onClose, onPrev, onNext, hasPrev, hasNext, view.s]);

  useEffect(() => {
    document.body.style.overflow = photo ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [photo]);

  const startDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    movedRef.current = 0;
    if (view.s === 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    setDragging(true);
  };

  const onDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    setView(v => ({ ...v, ...clampOffset(v.s, v.x + dx, v.y + dy) }));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.id !== e.pointerId) return;
    movedRef.current = dragRef.current.moved;
    dragRef.current = null;
    setDragging(false);
  };

  // 拖动平移之后不该顺手把信息层切掉
  const toggleInfo = () => {
    if (movedRef.current > 6) return;
    setInfoOpen(o => !o);
  };

  if (!photo) return null;

  const rows = liveExif ? exifRows(liveExif) : [];
  const zoomed = view.s > 1;

  return (
    <div
      className="lb"
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
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <button className="lb__close" onClick={onClose} aria-label="关闭">
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
              dragging ? 'lb__img--drag' : '',
            ].filter(Boolean).join(' ')}
            style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s * (loaded ? 1 : 0.985)})` }}
            onLoad={() => setLoaded(true)}
            onPointerDown={startDrag}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
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
