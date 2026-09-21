/**
 * Hall — 3D 展厅页
 *
 * 只负责壳：撑满视口的 canvas、加载进度、操作提示、走近哪张画的说明牌，
 * 以及手机上的虚拟摇杆。场景本身全在 hall/hall.ts 里。
 *
 * three 走动态 import，不进主包 —— 不点这个 tab 的人不该下这几百 KB。
 */
import { useEffect, useRef, useState } from 'react';
import type { Photo } from './data';
import type { HallHandle, HallPhoto } from './hall/hall';

interface HallProps {
  photos: Photo[];
  /** 走到画前按 Enter，或直接点画面 */
  onOpen: (photo: Photo) => void;
  /** 灯箱开着时为 true：展厅停掉，方向键才不会一键两用 */
  paused: boolean;
}

/** 摇杆半径（px），和 CSS 里的 .hall__stick 尺寸对应 */
const STICK_R = 46;

export function Hall({ photos, onOpen, paused }: HallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stickRef  = useRef<HTMLDivElement>(null);
  const hallRef   = useRef<HallHandle | null>(null);
  // 场景只在挂载时建一次，回调却要一直看到最新的 photos / onOpen
  const openRef   = useRef(onOpen);
  const photosRef = useRef(photos);
  openRef.current   = onOpen;
  photosRef.current = photos;

  const [progress, setProgress] = useState(0);
  const [ready,    setReady]    = useState(false);
  const [focused,  setFocused]  = useState<HallPhoto | null>(null);
  const [index,    setIndex]    = useState(0);
  const [knob,     setKnob]     = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !photos.length) return;
    let handle: HallHandle | null = null;
    let cancelled = false;

    // 策展顺序就是挂画顺序，和首页画廊看到的一致
    const list: HallPhoto[] = photos.map(p => ({
      id: p.id, title: p.title, src: p.src,
      location: p.location, year: p.year,
      width: p.exif?.width, height: p.exif?.height,
    }));

    import('./hall/hall').then(({ startHall }) => {
      if (cancelled) return;
      handle = startHall({
        canvas,
        photos: list,
        onProgress: setProgress,
        onReady:    () => setReady(true),
        onFocus:    setFocused,
        onIndex:    setIndex,
        onEnter: (hp) => {
          const p = photosRef.current.find(x => x.id === hp.id);
          if (p) openRef.current(p);
        },
      });
      hallRef.current = handle;
    });

    return () => {
      cancelled = true;
      handle?.stop();
      hallRef.current = null;
    };
    // 进展厅后再改动照片列表（发布 / 删除）不重建场景，走出去再进来才会刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length > 0]);

  useEffect(() => {
    hallRef.current?.setPaused(paused);
  }, [paused, ready]);

  // 展厅是全屏场景，背后的页面不该还能滚
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  /* ---------- 虚拟摇杆 ---------- */
  const onStickMove = (e: React.PointerEvent) => {
    const el = stickRef.current;
    if (!el || !knob) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, STICK_R) / len;
    const x = dx * clamped;
    const y = dy * clamped;
    setKnob({ x, y });
    hallRef.current?.setMove(x / STICK_R, y / STICK_R);
  };
  const endStick = () => {
    setKnob(null);
    hallRef.current?.setMove(0, 0);
  };

  const sub = focused
    ? [focused.location, focused.year].filter(Boolean).join(' · ')
    : '';

  return (
    <section className="hall" aria-label="3D 展厅">
      <canvas ref={canvasRef} className="hall__canvas" />

      {!ready && (
        <div className="hall__loader">
          <h2 className="hall__loader-title">光影 · 展厅</h2>
          <div className="hall__loader-line">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="hall__loader-sub">
            <span>{Math.round(progress * 100)}%</span>
            <span>{photos.length} WORKS</span>
          </div>
        </div>
      )}

      {ready && (
        <>
          <p className="hall__hint">
            <b>W A S D</b> 走动 · <b>Shift</b> 快走 · 画前停留 2s 自动正对 · <b>Enter</b> 看原图
          </p>

          <div className={`hall__plate ${focused ? 'on' : ''}`} aria-live="polite">
            {focused && (
              <>
                <span className="hall__plate-no">{String(index).padStart(2, '0')} / {photos.length}</span>
                <span className="hall__plate-title">{focused.title}</span>
                {sub && <span className="hall__plate-sub">{sub}</span>}
                <span className="hall__plate-cta">ENTER 查看原图</span>
              </>
            )}
          </div>

          <div
            ref={stickRef}
            className="hall__stick"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setKnob({ x: 0, y: 0 });
            }}
            onPointerMove={onStickMove}
            onPointerUp={endStick}
            onPointerCancel={endStick}
          >
            <i style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined} />
          </div>
        </>
      )}

      {!photos.length && <p className="hall__empty">还没有作品，展厅里空空的。</p>}
    </section>
  );
}
