import { useState, useEffect } from 'react';
import type { Photo } from './data';

interface LightboxProps {
  photo: Photo | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

export function Lightbox({ photo, onClose, onPrev, onNext, hasPrev, hasNext }: LightboxProps) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { setLoaded(false); }, [photo?.id]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (!photo) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [photo, onClose, onPrev, onNext, hasPrev, hasNext]);

  useEffect(() => {
    document.body.style.overflow = photo ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [photo]);

  if (!photo) return null;

  return (
    <div
      className="lb"
      role="dialog"
      aria-modal="true"
      aria-label={photo.title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <button className="lb__close" onClick={onClose} aria-label="关闭">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      <div className="lb__stage">
        {!loaded && <div className="lb__placeholder" />}
        <img
          key={photo.id}
          src={photo.src}
          alt={photo.title}
          className={`lb__img ${loaded ? 'lb__img--on' : ''}`}
          onLoad={() => setLoaded(true)}
        />
      </div>
      <div className="lb__caption">
        <span className="lb__caption-title">{photo.title}</span>
        {(photo.location || photo.year) && (
          <span className="lb__caption-meta">
            {[photo.location, photo.year].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
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
  );
}
