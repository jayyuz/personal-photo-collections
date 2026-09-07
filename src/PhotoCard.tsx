import { useState, useEffect, useRef } from 'react';
import type { Photo } from './data';

interface PhotoCardProps {
  photo: Photo;
  onClick: () => void;
  index: number;
}

export interface CardGeometry {
  /** 卡片这个「窗口」，overflow: hidden 之外的部分是看不见的 */
  frame: DOMRect;
  /** 窗口里那张图实际铺开的范围，含视差位移和 hover 的微放大 */
  box: DOMRect;
}

/**
 * 灯箱开合时要知道这张照片在屏幕上占哪一块，好让大图从那儿放大出来。
 * 用属性选择器去问 DOM，比把每张卡片的 ref 一路传到 App 再传进灯箱省事得多。
 */
export function cardGeometry(photoId: string): CardGeometry | null {
  const el = document.querySelector(`[data-photo-id="${CSS.escape(photoId)}"]`);
  if (!el) return null;
  const inner = el.querySelector('.card__inner');
  const img = el.querySelector('.card__img');
  return { frame: (inner ?? el).getBoundingClientRect(), box: (img ?? el).getBoundingClientRect() };
}

export function PhotoCard({ photo, onClick, index }: PhotoCardProps) {
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0, rootMargin: '0px 0px 300px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const spanClass =
    photo.span === 'wide' ? 'card--wide' :
    photo.span === 'tall' ? 'card--tall' :
    photo.span === 'big'  ? 'card--big'  : '';

  return (
    <div
      ref={ref}
      data-photo-id={photo.id}
      className={`card ${spanClass} ${visible ? 'card--visible' : ''}`}
      style={{ '--delay': `${(index % 8) * 55}ms` } as React.CSSProperties}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`查看: ${photo.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="card__inner">
        {!loaded && <div className="card__skeleton" aria-hidden="true" />}
        <div className="card__parallax" aria-hidden="true">
          {visible && (
            <img
              src={photo.src}
              alt={photo.title}
              className={`card__img ${loaded ? 'card__img--on' : ''}`}
              onLoad={() => setLoaded(true)}
              draggable={false}
            />
          )}
        </div>
        <div className="card__info">
          <span className="card__title">{photo.title}</span>
          {(photo.location || photo.year) && (
            <span className="card__meta">
              {[photo.location, photo.year].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
