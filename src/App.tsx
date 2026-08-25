import { useState, useEffect, useCallback, useRef } from 'react';
import { usePhotos } from './usePhotos';
import type { Photo } from './data';
import { PhotoCard } from './PhotoCard';
import { Lightbox } from './Lightbox';
import { AdminPanel } from './AdminPanel';

export default function App() {
  const { photos, uploadedPhotos, addPhoto, removePhoto } = usePhotos();
  const [lightboxPhoto, setLightboxPhoto] = useState<Photo | null>(null);
  const [page,      setPage]      = useState<'gallery' | 'about'>('gallery');
  const [scrolled,  setScrolled]  = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const heroRef = useRef<HTMLDivElement>(null);
  const bgRef   = useRef<HTMLImageElement>(null);
  const mouseOff = useRef({ x: 0, y: 0 });

  const currentIndex = lightboxPhoto ? photos.indexOf(lightboxPhoto) : -1;
  const openLightbox  = useCallback((p: Photo) => setLightboxPhoto(p), []);
  const closeLightbox = useCallback(() => setLightboxPhoto(null), []);
  const prevPhoto = useCallback(() => {
    if (currentIndex > 0) setLightboxPhoto(photos[currentIndex - 1]);
  }, [currentIndex, photos]);
  const nextPhoto = useCallback(() => {
    if (currentIndex < photos.length - 1) setLightboxPhoto(photos[currentIndex + 1]);
  }, [currentIndex, photos]);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  useEffect(() => {
    const hero = heroRef.current;
    const bg = bgRef.current;
    if (!hero || !bg || page !== 'gallery') return;
    const apply = (mx: number, my: number, sy: number, withT: boolean) => {
      bg.style.transition = withT ? 'transform 0.75s cubic-bezier(0.16,1,0.3,1)' : 'none';
      bg.style.transform  = `scale(1.1) translate(${mx}px, ${my + sy}px)`;
    };
    const onMove = (e: MouseEvent) => {
      const r = hero.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width  - 0.5) * 22;
      const my = ((e.clientY - r.top)  / r.height - 0.5) * 14;
      mouseOff.current = { x: mx, y: my };
      apply(mx, my, window.scrollY * 0.45, true);
    };
    const onLeave = () => {
      mouseOff.current = { x: 0, y: 0 };
      apply(0, 0, window.scrollY * 0.45, true);
    };
    hero.addEventListener('mousemove', onMove);
    hero.addEventListener('mouseleave', onLeave);
    return () => { hero.removeEventListener('mousemove', onMove); hero.removeEventListener('mouseleave', onLeave); };
  }, [page]);

  useEffect(() => {
    const bg = bgRef.current;
    if (!bg || page !== 'gallery') return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (window.scrollY > window.innerHeight * 1.2) return;
        const { x, y } = mouseOff.current;
        bg.style.transition = 'none';
        bg.style.transform  = `scale(1.1) translate(${x}px, ${y + window.scrollY * 0.45}px)`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [page]);

  return (
    <div className="app">
      <header className={`nav ${scrolled ? 'nav--bg' : ''}`}>
        <div className="nav__inner">
          <button className="nav__logo"
            onClick={() => { setPage('gallery'); setMenuOpen(false); }} aria-label="返回主页">
            <span className="nav__logo-main">光影</span>
            <span className="nav__logo-sub">PHOTOGRAPHY</span>
          </button>
          <nav className="nav__links" aria-label="主导航">
            <button className={`nav__link ${page === 'gallery' ? 'active' : ''}`}
              onClick={() => { setPage('gallery'); setMenuOpen(false); }}>Work</button>
            <button className={`nav__link ${page === 'about' ? 'active' : ''}`}
              onClick={() => { setPage('about'); setMenuOpen(false); }}>About</button>
          </nav>
          <button className={`nav__burger ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}
            aria-label={menuOpen ? '关闭菜单' : '打开菜单'}>
            <span /><span />
          </button>
        </div>
        {menuOpen && (
          <div className="nav__mob">
            <button onClick={() => { setPage('gallery'); setMenuOpen(false); }}>Work</button>
            <button onClick={() => { setPage('about'); setMenuOpen(false); }}>About</button>
          </div>
        )}
      </header>

      <main>
        {page === 'gallery' ? (
          <>
            <section className="hero" ref={heroRef} aria-label="封面">
              <img ref={bgRef} src="https://picsum.photos/seed/hero_main/2000/1200"
                alt="" aria-hidden="true" className="hero__bg" />
              <div className="hero__veil" />
              <div className="hero__body">
                <div className="hero__tag">Personal Photography · 2022–2024</div>
                <h1 className="hero__title">
                  <span className="hero__tl" aria-hidden="true">LIGHT</span>
                  <span className="hero__tl hero__tl--stroke" aria-hidden="true">&amp;</span>
                  <span className="hero__tl" aria-hidden="true">SHADOW</span>
                  <span className="sr-only">光与影</span>
                </h1>
                <p className="hero__desc">每一次按下快门，都是与时间的一场对话</p>
              </div>
              <div className="hero__count" aria-hidden="true">
                <span className="hero__count-n">{photos.length}</span>
                <span className="hero__count-l">WORKS</span>
              </div>
              <div className="hero__arrow" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1" strokeLinecap="round">
                  <line x1="12" y1="4" x2="12" y2="20" />
                  <polyline points="6 14 12 20 18 14" />
                </svg>
              </div>
            </section>

            <section className="gallery" aria-label="摄影作品">
              <div className="bento">
                {photos.map((photo, i) => (
                  <PhotoCard key={photo.id} photo={photo} index={i}
                    onClick={() => openLightbox(photo)} />
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="about">
            <div className="about__split">
              <div className="about__visual">
                <img src="https://picsum.photos/seed/about_me/900/1100"
                  alt="摄影师" className="about__photo" />
                <div className="about__visual-tag">Since 2020</div>
              </div>
              <div className="about__text">
                <p className="about__kicker">— The Story</p>
                <h2 className="about__h">用光和影<br />记录世界</h2>
                <p className="about__p">
                  我拍摄人与世界相遇的瞬间。无论是街头的烟火气，还是山野间的云涌雾散；
                  无论是花蕊里的微观宇宙，还是他人眼神深处的那点星光——
                  每一张照片都是与时间的一次对话。
                </p>
                <p className="about__p">
                  颜色是情绪，不是装饰。有时是大红大紫的喚崣热烈，
                  有时是恬静清醒的素白晨雾。我只是跟随光的方向，按下快门。
                </p>
                <div className="about__nums">
                  <div className="about__num"><b>{photos.length}</b><span>作品</span></div>
                  <div className="about__num"><b>4</b><span>年</span></div>
                  <div className="about__num"><b>12+</b><span>城市</span></div>
                </div>
                <button className="about__cta" onClick={() => setPage('gallery')}>
                  浏览作品
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <span>© {new Date().getFullYear()} 光影记录</span>
        <span className="footer__dot" aria-hidden="true">·</span>
        <span>All rights reserved</span>
      </footer>

      <button className="admin-fab" onClick={() => setAdminOpen(true)}
        aria-label="管理作品" title="上传 / 管理作品">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {uploadedPhotos.length > 0 && (
          <span className="admin-fab__badge">{uploadedPhotos.length}</span>
        )}
      </button>

      {adminOpen && (
        <AdminPanel
          uploadedPhotos={uploadedPhotos}
          onAdd={addPhoto}
          onDelete={removePhoto}
          onClose={() => setAdminOpen(false)}
        />
      )}

      <Lightbox
        photo={lightboxPhoto}
        onClose={closeLightbox}
        onPrev={prevPhoto}
        onNext={nextPhoto}
        hasPrev={currentIndex > 0}
        hasNext={currentIndex < photos.length - 1}
      />
    </div>
  );
}
