/**
 * AdminPanel — 图片管理抽屉
 *
 * 架构：
 *   图片  → Cloudinary（unsigned upload，无后端）
 *   元数据 → GitHub Contents API → public/photos.json
 *   触发  → GitHub Actions 自动构建并部署到 GitHub Pages
 *
 * 配置存 localStorage，Token 不进源码。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { Photo, PhotoSpan } from './data';
import { toPhoto } from './usePhotos';

const SPAN_OPTS: { value: PhotoSpan; label: string }[] = [
  { value: 'normal', label: '普通 1×1' },
  { value: 'wide',   label: '宽幅 2×1' },
  { value: 'tall',   label: '高幅 1×2' },
  { value: 'big',    label: '大图 2×2' },
];
const TINT_OPTS = [
  { label: '人物 · 暖红',  value: 'rgba(220,80,60,0.25)'    },
  { label: '人文 · 琥珀',  value: 'rgba(200,120,20,0.22)'   },
  { label: '花朵 · 洋红',  value: 'rgba(220,40,180,0.22)'   },
  { label: '风景 · 靛蓝',  value: 'rgba(40,120,200,0.22)'   },
  { label: '暮色 · 深紫',  value: 'rgba(80,40,160,0.25)'    },
  { label: '清爽 · 翠绿',  value: 'rgba(40,160,100,0.22)'   },
  { label: '极光 · 玫瑰',  value: 'rgba(200,40,120,0.22)'   },
  { label: '中性 · 灰调',  value: 'rgba(180,180,180,0.22)'  },
];
const LS_CONFIG_KEY = 'photo-admin-config-v1';

interface AdminConfig {
  githubRepo:     string;
  githubToken:    string;
  cloudName:      string;
  uploadPreset:   string;
}
interface FormState {
  title:    string;
  location: string;
  year:     string;
  span:     PhotoSpan;
  tint:     string;
}
interface ApiPhoto {
  id: string; title: string; src: string; span: string;
  location?: string; year?: number; tint: string;
}

function safeB64Encode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

async function uploadToCloudinary(base64DataUrl: string, cfg: AdminConfig): Promise<string> {
  const fd = new FormData();
  fd.append('file', base64DataUrl);
  fd.append('upload_preset', cfg.uploadPreset);
  fd.append('folder', 'photography');
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,
    { method: 'POST', body: fd }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Cloudinary: ${data.error.message}`);
  return (data.secure_url as string).replace('/upload/', '/upload/f_auto,q_auto,w_1600/');
}

const PHOTOS_PATH = 'public/photos.json';

async function fetchPhotosMeta(cfg: AdminConfig): Promise<{ photos: ApiPhoto[]; sha: string }> {
  const [owner, repo] = cfg.githubRepo.split('/');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${PHOTOS_PATH}`,
    { headers: { Authorization: `Bearer ${cfg.githubToken}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (res.status === 404) return { photos: [], sha: '' };
  if (!res.ok) { const e = await res.json(); throw new Error(e.message); }
  const data = await res.json();
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  return { photos: JSON.parse(content), sha: data.sha };
}

async function savePhotosMeta(photos: ApiPhoto[], cfg: AdminConfig, message: string): Promise<void> {
  const [owner, repo] = cfg.githubRepo.split('/');
  const { sha } = await fetchPhotosMeta(cfg).catch(() => ({ photos: [], sha: '' }));
  const body: Record<string, unknown> = {
    message,
    content: safeB64Encode(JSON.stringify(photos, null, 2)),
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${PHOTOS_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.githubToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) { const e = await res.json(); throw new Error(e.message); }
}

const DEFAULT_CONFIG: AdminConfig = { githubRepo: '', githubToken: '', cloudName: '', uploadPreset: '' };
const DEFAULT_FORM:   FormState   = {
  title: '', location: '', year: String(new Date().getFullYear()),
  span: 'normal', tint: TINT_OPTS[0].value,
};

interface AdminPanelProps {
  uploadedPhotos: Photo[];
  onAdd:    (p: Photo) => void;
  onDelete: (id: string) => void;
  onClose:  () => void;
}

export function AdminPanel({ uploadedPhotos, onAdd, onDelete, onClose }: AdminPanelProps) {
  const [cfg, setCfg] = useState<AdminConfig>(() => {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS_CONFIG_KEY) || '{}') }; }
    catch { return DEFAULT_CONFIG; }
  });
  const [cfgOpen, setCfgOpen] = useState(() =>
    !cfg.githubRepo || !cfg.githubToken || !cfg.cloudName || !cfg.uploadPreset
  );
  const [preview,  setPreview]  = useState<string | null>(null);
  const [base64,   setBase64]   = useState<string | null>(null);
  const [form,     setForm]     = useState<FormState>(DEFAULT_FORM);
  const [uploading, setUploading] = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const [status,    setStatus]    = useState<{ type: 'err' | 'ok'; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const saveCfg = (next: AdminConfig) => {
    setCfg(next);
    localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(next));
  };

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) { setStatus({ type: 'err', msg: '请选择图片文件（JPG / PNG / WebP）' }); return; }
    if (file.size > 20 * 1024 * 1024)   { setStatus({ type: 'err', msg: '文件大小不能超过 20 MB' }); return; }
    setStatus(null);
    const reader = new FileReader();
    reader.onload = e => {
      const r = e.target?.result as string;
      setBase64(r); setPreview(r);
    };
    reader.readAsDataURL(file);
    if (!form.title) setForm(f => ({ ...f, title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') }));
  }, [form.title]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const resetForm = () => {
    setPreview(null); setBase64(null); setForm(DEFAULT_FORM); setStatus(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const isConfigComplete = cfg.githubRepo && cfg.githubToken && cfg.cloudName && cfg.uploadPreset;

  const handleUpload = async () => {
    if (!base64) return;
    if (!form.title.trim()) { setStatus({ type: 'err', msg: '请填写作品标题' }); return; }
    if (!isConfigComplete) { setStatus({ type: 'err', msg: '请先完成上方的配置' }); return; }
    setUploading(true); setStatus(null);
    try {
      setStatus({ type: 'ok', msg: '📤 上传图片到 Cloudinary…' });
      const imgUrl = await uploadToCloudinary(base64, cfg);
      setStatus({ type: 'ok', msg: '🔄 同步到 GitHub…' });
      const { photos: currentPhotos } = await fetchPhotosMeta(cfg);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newEntry: ApiPhoto = {
        id,
        title:    form.title.trim(),
        src:      imgUrl,
        span:     form.span,
        location: form.location.trim() || undefined,
        year:     Number(form.year) || undefined,
        tint:     form.tint,
      };
      await savePhotosMeta([newEntry, ...currentPhotos], cfg, `📷 Add: ${form.title.trim()}`);
      onAdd(toPhoto(newEntry));
      resetForm();
      setStatus({ type: 'ok', msg: '✅ 上传成功！GitHub Actions 将在 1-2 分钟内重新部署网站。' });
    } catch (e) {
      setStatus({ type: 'err', msg: String(e) });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (photo: Photo) => {
    if (!window.confirm(`确认删除「${photo.title}」？`)) return;
    if (!isConfigComplete) { alert('请先完成配置'); return; }
    try {
      const { photos: current } = await fetchPhotosMeta(cfg);
      await savePhotosMeta(current.filter(p => p.id !== photo.id), cfg, `🗑️ Remove: ${photo.title}`);
      onDelete(photo.id);
    } catch (e) {
      alert(`删除失败：${String(e)}`);
    }
  };

  return (
    <>
      <div className="ap-mask" onClick={onClose} aria-hidden="true" />
      <aside className="ap" role="dialog" aria-modal="true" aria-label="作品管理">
        <div className="ap__head">
          <span className="ap__title">管理作品</span>
          <button className="ap__close" onClick={onClose} aria-label="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="ap__body">
          <section className="ap__section">
            <button
              className="ap__sec-title ap__sec-toggle"
              onClick={() => setCfgOpen(v => !v)}
            >
              <span>
                {isConfigComplete
                  ? <span className="ap__cfg-dot ap__cfg-dot--ok" />
                  : <span className="ap__cfg-dot ap__cfg-dot--warn" />
                }
                配置
              </span>
              <svg className={`ap__chevron ${cfgOpen ? 'ap__chevron--open' : ''}`}
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {cfgOpen && (
              <div className="ap__cfg-panel">
                <p className="ap__cfg-hint">配置只存在你的浏览器里（localStorage），不进代码。</p>
                {[
                  { key: 'githubRepo',   label: 'GitHub 仓库',              placeholder: 'owner/repo',       type: 'text'     },
                  { key: 'githubToken',  label: 'GitHub Token',             placeholder: 'ghp_xxxxxxxxxxxx', type: 'password' },
                  { key: 'cloudName',    label: 'Cloudinary 云名称',        placeholder: 'my-cloud-name',    type: 'text'     },
                  { key: 'uploadPreset', label: 'Upload Preset（unsigned）', placeholder: 'my-preset',        type: 'text'     },
                ].map(f => (
                  <label key={f.key} className="ap__label" style={{ marginBottom: 10 }}>
                    {f.label}
                    <input
                      className="ap__input"
                      type={f.type}
                      value={(cfg as Record<string, string>)[f.key]}
                      onChange={e => saveCfg({ ...cfg, [f.key]: e.target.value })}
                      placeholder={f.placeholder}
                      autoComplete="off"
                    />
                  </label>
                ))}
                <div className="ap__cfg-links">
                  <a href="https://cloudinary.com/users/register_free" target="_blank" rel="noreferrer">注册 Cloudinary →</a>
                  <a href="https://github.com/settings/tokens/new?scopes=repo&description=photo-portfolio" target="_blank" rel="noreferrer">生成 GitHub Token →</a>
                </div>
              </div>
            )}
          </section>

          <section className="ap__section">
            <h3 className="ap__sec-title">上传新作品</h3>
            {!preview ? (
              <div
                className={`ap__drop ${dragOver ? 'ap__drop--over' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
                aria-label="点击或拖拽图片到此处"
              >
                <svg className="ap__drop-icon" width="32" height="32" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
                  <rect x="3" y="3" width="18" height="18" rx="1" />
                  <circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                </svg>
                <span className="ap__drop-text">点击选择 或 拖拽图片</span>
                <span className="ap__drop-hint">JPG · PNG · WebP · ≤ 20 MB</span>
              </div>
            ) : (
              <div className="ap__preview">
                <img src={preview} alt="预览" className="ap__preview-img" />
                <button className="ap__preview-clear" onClick={resetForm} aria-label="重新选择">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
            <input
              ref={fileRef} type="file"
              accept="image/jpeg,image/png,image/webp"
              className="ap__file-input" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              tabIndex={-1}
            />
            <div className={`ap__form ${!preview ? 'ap__form--hidden' : ''}`}>
              <label className="ap__label">
                作品标题 <span className="ap__required">*</span>
                <input className="ap__input" type="text" value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="例：午后的光" maxLength={40} />
              </label>
              <div className="ap__row">
                <label className="ap__label">
                  拍摄地点
                  <input className="ap__input" type="text" value={form.location}
                    onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                    placeholder="例：北京" maxLength={20} />
                </label>
                <label className="ap__label">
                  年份
                  <input className="ap__input" type="number" value={form.year}
                    onChange={e => setForm(f => ({ ...f, year: e.target.value }))}
                    min={2000} max={2099} style={{ width: 90 }} />
                </label>
              </div>
              <label className="ap__label">
                布局大小
                <div className="ap__span-grid">
                  {SPAN_OPTS.map(o => (
                    <button key={o.value} type="button"
                      className={`ap__span-btn ${form.span === o.value ? 'ap__span-btn--active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, span: o.value }))}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="ap__label">
                色调氛围
                <div className="ap__tint-grid">
                  {TINT_OPTS.map(o => (
                    <button key={o.value} type="button" title={o.label}
                      className={`ap__tint-swatch ${form.tint === o.value ? 'ap__tint-swatch--active' : ''}`}
                      style={{ background: o.value.replace(/[\d.]+\)$/, '0.8)') }}
                      onClick={() => setForm(f => ({ ...f, tint: o.value }))}
                      aria-label={o.label} />
                  ))}
                </div>
              </label>
              {status && (
                <p className={status.type === 'err' ? 'ap__err' : 'ap__ok'}>{status.msg}</p>
              )}
              <button className="ap__submit" onClick={handleUpload}
                disabled={uploading || !base64 || !isConfigComplete}>
                {uploading ? <><span className="ap__spinner" /> 处理中…</> : '确认上传'}
              </button>
            </div>
            {!preview && status && (
              <p className={status.type === 'err' ? 'ap__err' : 'ap__ok'}
                style={{ marginTop: 8 }}>{status.msg}</p>
            )}
          </section>

          {uploadedPhotos.length > 0 && (
            <section className="ap__section">
              <h3 className="ap__sec-title">
                已上传 <span className="ap__count">{uploadedPhotos.length}</span>
              </h3>
              <ul className="ap__list">
                {uploadedPhotos.map(p => (
                  <li key={p.id} className="ap__item">
                    <div className="ap__item-thumb"><img src={p.src} alt={p.title} loading="lazy" /></div>
                    <div className="ap__item-info">
                      <span className="ap__item-title">{p.title}</span>
                      <span className="ap__item-meta">{[p.location, p.year, p.span].filter(Boolean).join(' · ')}</span>
                    </div>
                    <button className="ap__item-del" onClick={() => handleDelete(p)} aria-label={`删除 ${p.title}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 11v6M14 11v6M9 6V4h6v2" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
