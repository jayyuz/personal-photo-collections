/**
 * DepthLightbox — 3D 视差灯箱（从 Lightbox fork 出来的专用版本）
 *
 * 只管一件事：把照片当成一张有厚度的纸片，鼠标一动相机就绕着它小幅公转，
 * 近处走得快、远处走得慢，于是照片"转起来"了（真正的视角变换）。
 *
 * 之所以单独 fork 一份而不是往 Lightbox 里塞开关：
 *   - 视差要接管整个 stage 的尺寸/变换，和缩放、平移、FLIP 飞入那套逻辑挤在一起
 *     必然互相打架（放大时该平移还是该转？FLIP 动画期间 transform 归谁？）；
 *   - 这边可以按自己的节奏加深度调试控件（强度滑杆、深度图预览），不影响主灯箱；
 *   - 出问题时点「返回普通浏览」就退回 Lightbox，风险隔离。
 *
 * 什么时候用它：App 里那个 3D 开关打开 + 当前照片有 depth 字段。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Photo } from './data';
import type { ParallaxHandle } from './depth/parallax';
import { webglAvailable } from './depth/support';

interface DepthLightboxProps {
  photo: Photo | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  /** 退回普通灯箱（2D） */
  onExitDepth: () => void;
}

/** 视差强度默认值：近处相对画幅高度位移 12%，再大就开始失真 */
const DEFAULT_AMP = 0.12;

const reduceMotion = () =>
  typeof window !== 'undefined'
  && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

export function DepthLightbox({
  photo, onClose, onPrev, onNext, hasPrev, hasNext, onExitDepth,
}: DepthLightboxProps) {
  const viewRef   = useRef<HTMLDivElement>(null);
  const stageRef  = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<ParallaxHandle | null>(null);

  const [mode,   setMode]   = useState<'3d' | '2d'>(reduceMotion() ? '2d' : '3d');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [amp,    setAmp]    = useState(DEFAULT_AMP);
  // 渲染循环里要读最新强度，用 ref 镜像一份
  const ampRef = useRef(amp);
  useEffect(() => { ampRef.current = amp; }, [amp]);
  // 探测一次就够，环境不会中途变。IDE 内置浏览器之类拿不到 WebGL 时直接降级
  const glOk = useMemo(webglAvailable, []);

  const can3d = Boolean(photo?.depth);
  const live  = mode === '3d' && status === 'ready';

  /* ---------- 建/销毁渲染器 ---------- */
  useEffect(() => {
    if (!photo?.depth || mode !== '3d') return;
    const canvas = canvasRef.current;
    const stage  = stageRef.current;
    if (!canvas || !stage) return;

    let cancelled = false;
    if (!glOk) { setStatus('error'); return; }
    setStatus('loading');
    void (async () => {
      try {
        // three.js 有 600KB+，只在这条路径上动态拉，别拖慢首屏
        const { createParallax, depthUrl, loadDepthField } = await import('./depth/parallax');
        if (cancelled) return;
        const depth = await loadDepthField(depthUrl(photo.depth!));
        if (cancelled) return;
        const handle = await createParallax({
          canvas, container: stage, photoUrl: photo.src, depth, amplitude: ampRef.current,
        });
        if (cancelled) { handle.dispose(); return; }
        handleRef.current = handle;
        setStatus('ready');
      } catch (e) {
        console.error('[depth] 视差初始化失败', e);
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [photo?.id, photo?.depth, photo?.src, mode]);

  /* ---------- 鼠标 -> 视角 ---------- */
  // 挂在 view 上而不是复用手势逻辑：鼠标不按下时也要能转，所以必须自己收 pointermove
  useEffect(() => {
    const el = viewRef.current;
    const stage = stageRef.current;
    if (!el || !stage || !live) return;
    const onMove = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      handleRef.current?.setPointer(
        ((e.clientX - r.left) / r.width  - 0.5) * 2,
        ((e.clientY - r.top)  / r.height - 0.5) * 2,
      );
    };
    const onLeave = () => handleRef.current?.setPointer(0, 0);
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [live]);

  /* ---------- 键盘 / body 锁滚 ---------- */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft'  && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  useEffect(() => {
    document.body.style.overflow = photo ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [photo]);

  const onAmp = useCallback((v: number) => {
    setAmp(v);
    handleRef.current?.setAmplitude(v);
  }, []);

  if (!photo) return null;

  return (
    <div className="lb lb--depth" role="dialog" aria-modal="true" aria-label={`${photo.title}（3D 视差）`}>
      <div className="lb__backdrop" aria-hidden="true">
        <div className="lb__backdrop-veil" />
      </div>

      <div className="lb__view" ref={viewRef}>
        <div className="dlb__stage" ref={stageRef}>
          {/* 3D 就绪前（以及 2D 模式）用普通 <img> 顶着，永远不会白屏 */}
          <img
            key={photo.id}
            className={`dlb__img ${live ? 'dlb__img--off' : ''}`}
            src={photo.src}
            alt={photo.title}
            draggable={false}
          />
          <canvas ref={canvasRef} className={`dlb__canvas ${live ? 'dlb__canvas--on' : ''}`} />
        </div>

        <button className="lb__close" onClick={onClose} aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="dlb__bar">
          <button
            className={`dlb__chip ${mode === '3d' ? 'dlb__chip--on' : ''}`}
            onClick={() => setMode(m => (m === '3d' ? '2d' : '3d'))}
            disabled={!can3d}
            aria-pressed={mode === '3d'}
            title={can3d ? '开关 3D 视差' : '这张照片还没有深度图'}
          >
            3D
          </button>

          <label className="dlb__amp" aria-label="视差强度">
            <span>强度</span>
            <input
              type="range" min={0} max={0.3} step={0.01}
              value={amp} disabled={!live}
              onChange={e => onAmp(Number(e.target.value))}
            />
          </label>

          <button className="dlb__chip" onClick={onExitDepth} title="回到普通浏览（可缩放、看拍摄信息）">
            返回普通浏览
          </button>
        </div>

        {!can3d && (
          <p className="dlb__note">
            这张照片还没有深度图。跑 <code>python scripts/depth_export.py</code> 生成后再来看。
          </p>
        )}
        {can3d && !glOk && (
          <p className="dlb__note">
            当前环境拿不到 WebGL，3D 视差用不了，已退回平面显示。
            换 Chrome / Edge / Safari 打开（或在设置里打开硬件加速）即可。
          </p>
        )}
        {can3d && glOk && status === 'error' && (
          <p className="dlb__note">
            视差初始化失败（深度图没加载出来，或显卡驱动被禁用），已退回平面显示。
          </p>
        )}
        {can3d && status === 'loading' && mode === '3d' && (
          <p className="dlb__note dlb__note--soft">正在准备深度图…</p>
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

        <div className="dlb__caption">
          <span className="dlb__caption-title">{photo.title}</span>
          {photo.location && <span className="dlb__caption-sub">{photo.location}</span>}
        </div>
      </div>
    </div>
  );
}
