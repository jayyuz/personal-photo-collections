import { useState, useEffect, useRef } from 'react';
import type { Photo } from './data';

interface PhotoCardProps {
  photo: Photo;
  onClick: () => void;
  index: number;
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
      className={`card ${spanClass} ${visible ? 'card--visible' : ''}`}
      style={{ '--delay': `${(index % 8) * 55}ms`, '--tint': photo.tint } as React.CSSProperties}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`查看: ${photo.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
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
      <div className="card__tint" aria-hidden="true" />
      <div className="card__info">
        <span className="card__title">{photo.title}</span>
        {(photo.location || photo.year) && (
          <span className="card__meta">
            {[photo.location, photo.year].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}
