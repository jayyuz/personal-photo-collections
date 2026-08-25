/**
 * AdminPanel — 图片管理抽屉
 *
 * 架构：
 *   图片  → Cloudinary（unsigned upload，无后端）或已有 Cloudinary URL
 *   元数据 → GitHub Contents API → public/photos.json
 *   触发  → GitHub Actions 自动构建并部署到 GitHub Pages
 *
 * 配置存 localStorage，Token 不进源码。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import type { Photo, PhotoExif, PhotoSpan } from './data';
import { toPhoto } from './usePhotos';
import { readExif, readExifFromUrl } from './exif';

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
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH = 60;
const LIB_PAGE = 60;
const CLOUDINARY_URL_RE = /https?:\/\/res\.cloudinary\.com\/[^/\s]+\/(?:image|video)\/upload\/[^\s,;]+/gi;

interface AdminConfig {
  githubRepo:     string;
  githubToken:    string;
  cloudName:      string;
  uploadPreset:   string;
  listTag:        string;
  apiKey:         string;
  apiSecret:      string;
}
interface CloudAsset {
  publicId: string;
  url:      string;
  title:    string;
}
interface FormState {
  location: string;
  year:     string;
  span:     PhotoSpan;
  tint:     string;
}
interface ApiPhoto {
  id: string; title: string; src: string; span: string;
  location?: string; year?: number; tint: string; cover?: boolean;
  exif?: PhotoExif;
}
interface PendingItem {
  localId:    string;
  title:      string;
  preview:    string;
  base64:     string | null;
  remoteUrl:  string | null;
  exif?:      PhotoExif;
}

function safeB64Encode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim() || 'untitled';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 容忍用户粘贴 res.cloudinary.com 链接或 cloudinary:// 连接串，只取云名称 */
function normalizeCloudName(raw: string): string {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  const fromUrl = v.match(/res\.cloudinary\.com\/([^/\s]+)/)?.[1]
    ?? v.match(/^cloudinary:\/\/[^@]*@([^/\s]+)/)?.[1];
  return (fromUrl ?? v).replace(/^\/+|\/+$/g, '');
}

function optimizeCloudinaryUrl(url: string): string {
  if (/\/upload\/[^/]*f_auto/.test(url)) return url;
  return url.replace('/upload/', '/upload/f_auto,q_auto,w_1600/');
}

function extractCloudinaryUrls(text: string): string[] {
  const found = text.match(CLOUDINARY_URL_RE) ?? [];
  const cleaned = found.map(u => u.replace(/[)\].,;]+$/, ''));
  return [...new Set(cleaned)];
}

function assetUrl(cloud: string, publicId: string, format?: string): string {
  const suffix = format ? `.${format}` : '';
  return optimizeCloudinaryUrl(
    `https://res.cloudinary.com/${cloud}/image/upload/${publicId}${suffix}`
  );
}

function toAsset(cloud: string, r: {
  public_id?: string; format?: string; filename?: string; secure_url?: string;
}): CloudAsset | null {
  if (!r.public_id) return null;
  const url = r.secure_url
    ? optimizeCloudinaryUrl(r.secure_url)
    : assetUrl(cloud, r.public_id, r.format);
  const leaf = r.public_id.split('/').pop() || r.filename || r.public_id;
  return { publicId: r.public_id, url, title: titleFromName(leaf) };
}

async function listByTag(cloud: string, tag: string): Promise<CloudAsset[]> {
  const res = await fetch(
    `https://res.cloudinary.com/${encodeURIComponent(cloud)}/image/list/${encodeURIComponent(tag)}.json`
  );
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error('LIST_RESTRICTED');
  }
  if (!res.ok) throw new Error(`列出失败（HTTP ${res.status}）`);
  const data = await res.json();
  return (data.resources ?? [])
    .map((r: { public_id?: string; format?: string; filename?: string; secure_url?: string }) => toAsset(cloud, r))
    .filter((a: CloudAsset | null): a is CloudAsset => Boolean(a));
}

async function listByAdminApi(cloud: string, apiKey: string, apiSecret: string): Promise<CloudAsset[]> {
  const assets: CloudAsset[] = [];
  let cursor = '';
  for (let page = 0; page < 8; page++) {
    const q = new URLSearchParams({ max_results: '100', type: 'upload' });
    if (cursor) q.set('next_cursor', cursor);
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/image?${q}`,
      { headers: { Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}` } }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `Admin API 失败（HTTP ${res.status}）`);
    }
    const data = await res.json();
    for (const r of data.resources ?? []) {
      const a = toAsset(cloud, r);
      if (a) assets.push(a);
    }
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return assets;
}

async function listCloudinaryAssets(cfg: AdminConfig): Promise<CloudAsset[]> {
  const cloud = normalizeCloudName(cfg.cloudName);
  if (!cloud) throw new Error('请先填写 Cloudinary 云名称');
  const tag = cfg.listTag.trim() || 'photography';

  let tagError: unknown;
  try {
    const tagged = await listByTag(cloud, tag);
    if (tagged.length) return tagged;
  } catch (e) {
    tagError = e;
  }

  if (cfg.apiKey.trim() && cfg.apiSecret.trim()) {
    try {
      return await listByAdminApi(cloud, cfg.apiKey.trim(), cfg.apiSecret.trim());
    } catch (e) {
      const msg = String(e);
      if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
        throw new Error(
          'Admin API 不能从浏览器直接调用。请到 Settings → Security → Restricted image types，取消勾选 Resource list，并给图片打上列表标签。'
        );
      }
      throw e;
    }
  }

  if (tagError instanceof Error && tagError.message === 'LIST_RESTRICTED') {
    throw new Error(
      `标签列表被关闭。请到 Settings → Security，在 Restricted image types 里取消勾选 Resource list，` +
      `然后给要导入的图加上标签「${tag}」。本面板上传的新图会自动打上该标签。`
    );
  }
  throw new Error(
    `没有拉到带标签「${tag}」的图片。在 Media Library 给已有图加上这个标签后再试，` +
    `或填写 API Key / API Secret。本面板上传的新图会自动打上该标签。`
  );
}

async function uploadToCloudinary(base64DataUrl: string, cfg: AdminConfig): Promise<string> {
  const cloudName    = normalizeCloudName(cfg.cloudName);
  const uploadPreset = cfg.uploadPreset.trim().replace(/^["']|["']$/g, '');
  if (!cloudName || !uploadPreset) throw new Error('请填写 Cloudinary 云名称与 Upload Preset');

  const fd = new FormData();
  fd.append('file', base64DataUrl);
  fd.append('upload_preset', uploadPreset);
  fd.append('folder', 'photography');
  fd.append('tags', cfg.listTag.trim() || 'photography');
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    { method: 'POST', body: fd }
  );
  const data = await res.json().catch(() => null);
  const errMsg = data?.error?.message as string | undefined;

  if (errMsg && /unknown api key/i.test(errMsg)) {
    throw new Error(
      `Cloudinary 不认识云名称「${cloudName}」。请在控制台 Settings → API Keys ` +
      `复制 Cloud name（不是 API Key），并确认 Upload Preset 为 Unsigned。`
    );
  }
  if (errMsg && /unsigned/i.test(errMsg)) {
    throw new Error(
      `Upload Preset「${uploadPreset}」不是 Unsigned。请到 Settings → Upload → Upload presets，` +
      `把 Signing Mode 改成 Unsigned，或新建一个 unsigned 预设，把预设名称填到这里。`
    );
  }
  if (errMsg)            throw new Error(`Cloudinary: ${errMsg}`);
  if (!res.ok)           throw new Error(`Cloudinary 上传失败（HTTP ${res.status}）`);
  if (!data?.secure_url) throw new Error('Cloudinary 未返回图片地址');

  return optimizeCloudinaryUrl(data.secure_url as string);
}

const PHOTOS_PATH = 'public/photos.json';

/** 容忍粘贴仓库主页链接或 git 地址，统一成 owner/repo */
function normalizeRepo(raw: string): string {
  const v = raw.trim().replace(/^["']|["']$/g, '').replace(/\.git$/, '');
  const parts = v
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:www\.)?github\.com\//i, '')
    .split('/')
    .filter(Boolean);
  return parts.slice(0, 2).join('/');
}

function repoParts(cfg: AdminConfig): [string, string] {
  const [owner, repo] = normalizeRepo(cfg.githubRepo).split('/');
  if (!owner || !repo) {
    throw new Error(`GitHub 仓库要填 owner/repo，例如 jayyuz/personal-photo-collections（当前：「${cfg.githubRepo}」）`);
  }
  return [owner, repo];
}

async function fetchPhotosMeta(cfg: AdminConfig): Promise<{ photos: ApiPhoto[]; sha: string }> {
  const [owner, repo] = repoParts(cfg);
  // 不能吃缓存：拿到旧的 sha 会让后续写入直接 409，或覆盖掉别处的改动
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${PHOTOS_PATH}?t=${Date.now()}`,
    {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'If-None-Match': '',
      },
    }
  );
  if (res.status === 404) return { photos: [], sha: '' };
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.message as string | undefined;
    throw new Error(detail || `读取 photos.json 失败（HTTP ${res.status}）`);
  }
  const data = await res.json();
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  return { photos: JSON.parse(content), sha: data.sha };
}

async function savePhotosMeta(photos: ApiPhoto[], cfg: AdminConfig, message: string): Promise<void> {
  const [owner, repo] = repoParts(cfg);
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
  if (res.ok) return;

  const detail = (await res.json().catch(() => null))?.message as string | undefined;
  if (res.status === 404) {
    throw new Error(
      `写入 ${owner}/${repo} 失败（404）。请确认仓库名正确、Token 属于该仓库的账号，且勾选了 repo 权限。`
    );
  }
  if (res.status === 403 || res.status === 401) {
    // 读取公开仓库不需要授权，所以能读不能写基本都是 Token 权限不足
    const needed = res.headers.get('x-accepted-github-permissions');
    throw new Error(
      `Token 没有写入 ${owner}/${repo} 的权限（HTTP ${res.status}${detail ? `：${detail}` : ''}）。` +
      `Classic Token 需要勾选 repo；Fine-grained Token 需要把该仓库加入 Repository access，` +
      `并把 Contents 设为 Read and write。` +
      (needed ? `（GitHub 要求：${needed}）` : '')
    );
  }
  throw new Error(detail || `写入失败（HTTP ${res.status}）`);
}

const DEFAULT_CONFIG: AdminConfig = {
  githubRepo: '', githubToken: '', cloudName: '', uploadPreset: '',
  listTag: 'photography', apiKey: '', apiSecret: '',
};
const DEFAULT_FORM: FormState = {
  location: '', year: String(new Date().getFullYear()),
  span: 'normal', tint: TINT_OPTS[0].value,
};

const CFG_FIELDS: { key: keyof AdminConfig; label: string; placeholder: string; type: 'text' | 'password' }[] = [
  { key: 'githubRepo',   label: 'GitHub 仓库',             placeholder: 'owner/repo',       type: 'text'     },
  { key: 'githubToken',  label: 'GitHub Token',            placeholder: 'ghp_xxxxxxxxxxxx', type: 'password' },
  { key: 'cloudName',    label: 'Cloudinary 云名称',       placeholder: 'dxxxxxxx',         type: 'text'     },
  { key: 'uploadPreset', label: 'Upload Preset',           placeholder: 'ml_default',       type: 'text'     },
  { key: 'listTag',      label: '图库标签（拉取用）',      placeholder: 'photography',      type: 'text'     },
  { key: 'apiKey',       label: 'API Key（可选）',         placeholder: '数字 Key',         type: 'text'     },
  { key: 'apiSecret',    label: 'API Secret（可选）',      placeholder: '仅用于拉取图库',   type: 'password' },
];

interface AdminPanelProps {
  uploadedPhotos: Photo[];
  onAdd:      (photos: Photo[]) => void;
  onDelete:   (id: string) => void;
  onSetCover: (id: string) => void;
  onClose:    () => void;
}

export function AdminPanel({ uploadedPhotos, onAdd, onDelete, onSetCover, onClose }: AdminPanelProps) {
  const [cfg, setCfg] = useState<AdminConfig>(() => {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(LS_CONFIG_KEY) || '{}') }; }
    catch { return DEFAULT_CONFIG; }
  });
  const [cfgOpen, setCfgOpen] = useState(() =>
    !cfg.githubRepo || !cfg.githubToken
  );
  const [tab,       setTab]       = useState<'add' | 'manage'>('add');
  const [pending,   setPending]   = useState<PendingItem[]>([]);
  const [urlDraft,  setUrlDraft]  = useState('');
  const [urlOpen,   setUrlOpen]   = useState(false);
  const [library,   setLibrary]   = useState<CloudAsset[]>([]);
  const [picked,    setPicked]    = useState<Set<string>>(new Set());
  const [libQuery,  setLibQuery]  = useState('');
  const [libShown,  setLibShown]  = useState(LIB_PAGE);
  const [listing,   setListing]   = useState(false);
  const [form,      setForm]      = useState<FormState>(DEFAULT_FORM);
  const [uploading, setUploading] = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const [status,    setStatus]    = useState<{ type: 'err' | 'ok'; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastPickRef = useRef<number | null>(null);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', fn);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const saveCfg = (next: AdminConfig) => {
    const trimmed: AdminConfig = {
      githubRepo:   next.githubRepo.trim(),
      githubToken:  next.githubToken.trim(),
      cloudName:    next.cloudName.trim(),
      uploadPreset: next.uploadPreset.trim(),
      listTag:      next.listTag.trim() || 'photography',
      apiKey:       next.apiKey.trim(),
      apiSecret:    next.apiSecret.trim(),
    };
    setCfg(trimmed);
    localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(trimmed));
  };

  const appendPending = useCallback((items: PendingItem[]) => {
    setPending(prev => {
      const room = MAX_BATCH - prev.length;
      if (room <= 0) {
        setStatus({ type: 'err', msg: `一次最多 ${MAX_BATCH} 张` });
        return prev;
      }
      const next = items.slice(0, room);
      if (items.length > room) setStatus({ type: 'err', msg: `已截取前 ${room} 张（上限 ${MAX_BATCH}）` });
      else setStatus(null);
      return [...prev, ...next];
    });
  }, []);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const ok: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        setStatus({ type: 'err', msg: `已跳过非图片文件：${file.name}` });
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setStatus({ type: 'err', msg: `${file.name} 超过 20 MB` });
        continue;
      }
      ok.push(file);
    }
    if (!ok.length) return;
    const items: PendingItem[] = await Promise.all(ok.map(async file => {
      const [dataUrl, exif] = await Promise.all([readFileAsDataUrl(file), readExif(file)]);
      return {
        localId:   newLocalId(),
        title:     titleFromName(file.name),
        preview:   dataUrl,
        base64:    dataUrl,
        remoteUrl: null,
        exif,
      };
    }));
    appendPending(items);
  }, [appendPending]);

  const addUrlsFromText = useCallback((text: string) => {
    const urls = extractCloudinaryUrls(text);
    if (!urls.length) {
      setStatus({ type: 'err', msg: '没有识别到 Cloudinary 链接。请粘贴 res.cloudinary.com 的图片 URL。' });
      return;
    }
    void (async () => {
      setStatus({ type: 'ok', msg: '正在从网络图片读取 EXIF…' });
      const items = await Promise.all(urls.map(async url => {
        const optimized = optimizeCloudinaryUrl(url);
        return {
          localId:   newLocalId(),
          title:     titleFromName(decodeURIComponent(url.split('/').pop() || 'photo')),
          preview:   optimized,
          base64:    null,
          remoteUrl: optimized,
          exif:      await readExifFromUrl(url),
        };
      }));
      appendPending(items);
    })();
    setUrlDraft('');
  }, [appendPending]);

  const fetchLibrary = async () => {
    setListing(true);
    setStatus(null);
    try {
      const assets = await listCloudinaryAssets(cfg);
      const already = new Set([
        ...uploadedPhotos.map(p => p.src),
        ...pending.map(p => p.remoteUrl).filter(Boolean) as string[],
      ]);
      const fresh = assets.filter(a =>
        ![...already].some(src => src.includes(a.publicId) || src === a.url)
      );
      setLibrary(fresh);
      setPicked(new Set());
      setLibQuery('');
      setLibShown(LIB_PAGE);
      lastPickRef.current = null;
      if (!fresh.length) {
        setStatus({ type: 'ok', msg: `拉到 ${assets.length} 张，都已经在站点或队列里了。` });
      } else {
        setStatus({ type: 'ok', msg: `拉到 ${assets.length} 张，其中 ${fresh.length} 张可导入。` });
      }
    } catch (e) {
      setLibrary([]);
      setStatus({ type: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setListing(false);
    }
  };

  const queuePickedFromLibrary = () => {
    const selected = library.filter(a => picked.has(a.publicId));
    if (!selected.length) {
      setStatus({ type: 'err', msg: '请先勾选要导入的图片' });
      return;
    }
    void (async () => {
      setStatus({ type: 'ok', msg: `正在从 ${selected.length} 张网络图片读取 EXIF…` });
      const items = await Promise.all(selected.map(async a => ({
        localId:   newLocalId(),
        title:     a.title,
        preview:   a.url,
        base64:    null,
        remoteUrl: a.url,
        exif:      await readExifFromUrl(a.url),
      })));
      appendPending(items);
      setLibrary(prev => prev.filter(a => !picked.has(a.publicId)));
      setPicked(new Set());
      lastPickRef.current = null;
    })();
  };

  const q = libQuery.trim().toLowerCase();
  const shownLibrary = q
    ? library.filter(a => `${a.title} ${a.publicId}`.toLowerCase().includes(q))
    : library;
  const visibleLibrary = shownLibrary.slice(0, libShown);
  const allShownPicked = shownLibrary.length > 0 && shownLibrary.every(a => picked.has(a.publicId));

  /** 支持 Shift 连选，避免上百张时一个个点 */
  const togglePick = (index: number, shift: boolean) => {
    setPicked(prev => {
      const next = new Set(prev);
      const anchor = lastPickRef.current;
      if (shift && anchor !== null && anchor !== index) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        const turnOn = !next.has(shownLibrary[index].publicId);
        for (let i = from; i <= to; i++) {
          const id = shownLibrary[i]?.publicId;
          if (!id) continue;
          if (turnOn) next.add(id);
          else next.delete(id);
        }
      } else {
        const id = shownLibrary[index].publicId;
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    lastPickRef.current = index;
  };

  const toggleAllShown = () => {
    setPicked(prev => {
      const next = new Set(prev);
      for (const a of shownLibrary) {
        if (allShownPicked) next.delete(a.publicId);
        else next.add(a.publicId);
      }
      return next;
    });
    lastPickRef.current = null;
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const resetQueue = () => {
    setPending([]);
    setUrlDraft('');
    setForm(DEFAULT_FORM);
    setStatus(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const isGithubOk      = Boolean(normalizeRepo(cfg.githubRepo).includes('/') && cfg.githubToken);
  const isCloudinaryOk  = Boolean(cfg.cloudName && cfg.uploadPreset);
  const hasLocalFiles   = pending.some(p => p.base64);
  const titlesOk        = pending.length > 0 && pending.every(p => p.title.trim());
  const canSubmit       = isGithubOk && titlesOk && (!hasLocalFiles || isCloudinaryOk);

  const handleUpload = async () => {
    if (!pending.length) return;
    if (!titlesOk) { setStatus({ type: 'err', msg: '每张图都需要标题' }); return; }
    if (!isGithubOk) { setStatus({ type: 'err', msg: '请先填写 GitHub 仓库和 Token' }); return; }
    if (hasLocalFiles && !isCloudinaryOk) {
      setStatus({ type: 'err', msg: '本地文件上传需要 Cloudinary 云名称和 Unsigned Upload Preset' });
      return;
    }
    setUploading(true); setStatus(null);
    try {
      const entries: ApiPhoto[] = [];
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        setStatus({ type: 'ok', msg: `处理 ${i + 1}/${pending.length}：${item.title}` });
        const src = item.remoteUrl
          ?? await uploadToCloudinary(item.base64!, cfg);
        // 已有图片没带 EXIF 时尽力从投递地址读一次，失败就留空
        const exif = item.exif ?? (item.remoteUrl ? await readExifFromUrl(src) : undefined);
        entries.push({
          id:       newLocalId(),
          title:    item.title.trim(),
          src,
          span:     form.span,
          location: form.location.trim() || undefined,
          year:     Number(form.year) || undefined,
          tint:     form.tint,
          exif,
        });
      }
      setStatus({ type: 'ok', msg: '同步到 GitHub…' });
      const { photos: currentPhotos } = await fetchPhotosMeta(cfg);
      const label = entries.length === 1 ? entries[0].title : `${entries.length} photos`;
      await savePhotosMeta([...entries, ...currentPhotos], cfg, `📷 Add: ${label}`);
      onAdd(entries.map(toPhoto));
      resetQueue();
      setStatus({
        type: 'ok',
        msg: `已添加 ${entries.length} 张。GitHub Actions 约 1–2 分钟后会重新部署网站。`,
      });
    } catch (e) {
      setStatus({ type: 'err', msg: String(e) });
    } finally {
      setUploading(false);
    }
  };

  const [coverBusy, setCoverBusy] = useState<string | null>(null);

  const handleSetCover = async (photo: Photo) => {
    if (!isGithubOk) { setStatus({ type: 'err', msg: '请先填写 GitHub 仓库和 Token' }); return; }
    setCoverBusy(photo.id);
    setStatus(null);
    try {
      const { photos: current } = await fetchPhotosMeta(cfg);
      const next = current.map(p => (
        p.id === photo.id ? { ...p, cover: true } : { ...p, cover: undefined }
      ));
      await savePhotosMeta(next, cfg, `🖼️ Cover: ${photo.title}`);
      onSetCover(photo.id);
      setStatus({ type: 'ok', msg: `已把「${photo.title}」设为首屏背景，部署后生效。` });
    } catch (e) {
      setStatus({ type: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setCoverBusy(null);
    }
  };

  const handleDelete = async (photo: Photo) => {
    if (!window.confirm(`确认删除「${photo.title}」？`)) return;
    if (!isGithubOk) { alert('请先完成 GitHub 配置'); return; }
    try {
      const { photos: current } = await fetchPhotosMeta(cfg);
      await savePhotosMeta(current.filter(p => p.id !== photo.id), cfg, `🗑️ Remove: ${photo.title}`);
      onDelete(photo.id);
    } catch (e) {
      alert(`删除失败：${String(e)}`);
    }
  };

  return (
    <div className="apf" role="dialog" aria-modal="true" aria-label="作品管理">
      <header className="apf__bar">
        <div className="apf__bar-side">
          <span className="apf__brand">管理作品</span>
          <nav className="apf__tabs" aria-label="管理分区">
            <button className={`apf__tab ${tab === 'add' ? 'apf__tab--on' : ''}`}
              onClick={() => setTab('add')}>添加</button>
            <button className={`apf__tab ${tab === 'manage' ? 'apf__tab--on' : ''}`}
              onClick={() => setTab('manage')}>已发布</button>
          </nav>
        </div>
        <div className="apf__bar-side">
          <button className={`apf__cfg-btn ${isGithubOk ? '' : 'apf__cfg-btn--warn'}`}
            onClick={() => setCfgOpen(v => !v)} aria-expanded={cfgOpen}>
            <span className={`ap__cfg-dot ${isGithubOk ? 'ap__cfg-dot--ok' : 'ap__cfg-dot--warn'}`} />
            配置
          </button>
          <button className="ap__close" onClick={onClose} aria-label="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {cfgOpen && (
        <div className="apf__cfg">
          <div className="apf__cfg-inner">
                <p className="ap__cfg-hint">配置只存在你的浏览器里（localStorage），不进代码。</p>
                {CFG_FIELDS.map(f => (
                  <label key={f.key} className="ap__label" style={{ marginBottom: 10 }}>
                    {f.label}
                    <input
                      className="ap__input"
                      type={f.type}
                      value={cfg[f.key]}
                      onChange={e => saveCfg({ ...cfg, [f.key]: e.target.value })}
                      placeholder={f.placeholder}
                      autoComplete="off"
                    />
                    {f.key === 'githubRepo' && (
                      <span className="ap__field-help">
                        只填 <strong>owner/repo</strong>，例如 jayyuz/personal-photo-collections，不要填完整网址。
                      </span>
                    )}
                    {f.key === 'githubToken' && (
                      <span className="ap__field-help">
                        需要写入权限：Classic Token 勾选 <strong>repo</strong>；
                        Fine-grained Token 要把本仓库加进 Repository access，并把 Contents 设为 <strong>Read and write</strong>。
                      </span>
                    )}
                    {f.key === 'cloudName' && (
                      <span className="ap__field-help">
                        Settings → API Keys 里的 Cloud name，不是 API Key。
                      </span>
                    )}
                    {f.key === 'uploadPreset' && (
                      <span className="ap__field-help">
                        打开 Cloudinary → Settings → Upload → Upload presets。
                        点 Add upload preset，Signing Mode 选 <strong>Unsigned</strong>，
                        保存后把预设名称（Preset name）填到这里。
                        只粘贴已有链接时可以不填。
                      </span>
                    )}
                    {f.key === 'listTag' && (
                      <span className="ap__field-help">
                        拉取图库时按这个标签过滤。本面板上传的图会自动打上它。
                        已有图片请在 Media Library 里补上同一标签。
                        同时要在 Settings → Security → Restricted image types 取消勾选 <strong>Resource list</strong>。
                      </span>
                    )}
                    {f.key === 'apiSecret' && (
                      <span className="ap__field-help">
                        可选。用来尝试拉取账号里全部图片；很多情况下浏览器会被 CORS 拦住，优先用标签列表。
                      </span>
                    )}
                  </label>
                ))}
            <div className="ap__cfg-links">
              <a href="https://console.cloudinary.com/app/settings/security" target="_blank" rel="noreferrer">放开 Resource list →</a>
              <a href="https://console.cloudinary.com/app/settings/upload" target="_blank" rel="noreferrer">Upload presets 设置 →</a>
              <a href="https://github.com/settings/tokens/new?scopes=repo&description=photo-portfolio" target="_blank" rel="noreferrer">生成 GitHub Token →</a>
            </div>
          </div>
        </div>
      )}

      {tab === 'add' ? (
        <div className="apf__main">
          <section className="apf__pane">
            <div className="apf__pane-head">
              <span className="apf__pane-title">图片来源</span>
              <div className="apf__pane-acts">
                <button type="button" className="apf__mini"
                  onClick={() => void fetchLibrary()}
                  disabled={listing || !cfg.cloudName.trim()}>
                  {listing ? '正在拉取…' : '拉取 Cloudinary 图库'}
                </button>
                <button type="button" className="apf__mini" onClick={() => setUrlOpen(v => !v)}>
                  {urlOpen ? '收起链接输入' : '粘贴链接'}
                </button>
              </div>
            </div>
            <div className="apf__pane-body">
            <div
              className={`ap__drop ${dragOver ? 'ap__drop--over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
              aria-label="点击或拖拽图片到此处，可一次多选"
            >
              <svg className="ap__drop-icon" width="32" height="32" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="1" />
                <circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
              </svg>
              <span className="ap__drop-text">点击选择 或 拖拽图片</span>
              <span className="ap__drop-hint">可多选 · JPG PNG WebP · ≤ 20 MB · 最多 {MAX_BATCH} 张</span>
            </div>
            <input
              ref={fileRef} type="file" multiple
              accept="image/jpeg,image/png,image/webp"
              className="ap__file-input"
              onChange={e => { if (e.target.files?.length) void handleFiles(e.target.files); e.target.value = ''; }}
              tabIndex={-1}
            />

            {urlOpen && (
              <div className="apf__url">
                <label className="ap__label">
                  粘贴已有 Cloudinary 链接
                  <textarea
                    className="ap__input ap__textarea"
                    rows={3}
                    value={urlDraft}
                    onChange={e => setUrlDraft(e.target.value)}
                    onPaste={e => {
                      const text = e.clipboardData.getData('text');
                      if (extractCloudinaryUrls(text).length) {
                        e.preventDefault();
                        addUrlsFromText(`${urlDraft}\n${text}`);
                      }
                    }}
                    placeholder={'每行一条，例如：\nhttps://res.cloudinary.com/你的云名/image/upload/v1/photo.jpg'}
                  />
                </label>
                <button
                  type="button"
                  className="ap__ghost"
                  onClick={() => addUrlsFromText(urlDraft)}
                  disabled={!urlDraft.trim() || uploading}
                >
                  加入队列
                </button>
              </div>
            )}

            {library.length > 0 && (
              <div className="ap__lib">
                <div className="ap__lib-bar">
                  <input
                    className="ap__input apf__search"
                    type="search"
                    value={libQuery}
                    onChange={e => { setLibQuery(e.target.value); setLibShown(LIB_PAGE); lastPickRef.current = null; }}
                    placeholder="按名称筛选…"
                  />
                  <span className="apf__hint">已选 {picked.size} / {shownLibrary.length}</span>
                  <button type="button" className="ap__lib-link" onClick={toggleAllShown}>
                    {allShownPicked ? '取消全选' : '全选'}
                  </button>
                  <button type="button" className="ap__lib-link"
                    onClick={queuePickedFromLibrary} disabled={!picked.size}>
                    加入队列
                  </button>
                </div>
                <p className="apf__hint">按住 Shift 点击可连选一段</p>
                {shownLibrary.length === 0 ? (
                  <p className="apf__empty">没有匹配的图片</p>
                ) : (
                  <>
                    <ul className="ap__lib-grid">
                      {visibleLibrary.map((a, i) => {
                        const on = picked.has(a.publicId);
                        return (
                          <li key={a.publicId}>
                            <button
                              type="button"
                              className={`ap__lib-card ${on ? 'ap__lib-card--on' : ''}`}
                              aria-pressed={on}
                              onClick={e => togglePick(i, e.shiftKey)}
                            >
                              <img src={a.url} alt={a.title} loading="lazy" />
                              <span className="ap__lib-tick" aria-hidden="true">
                                {on && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                    stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                    <polyline points="5 13 10 18 19 6" />
                                  </svg>
                                )}
                              </span>
                              <span className="ap__lib-name">{a.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {visibleLibrary.length < shownLibrary.length && (
                      <button type="button" className="ap__ghost"
                        onClick={() => setLibShown(n => n + LIB_PAGE)}>
                        显示更多（还有 {shownLibrary.length - visibleLibrary.length} 张）
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            </div>
          </section>

          <aside className="apf__pane apf__pane--rail">
            <div className="apf__pane-head">
              <span className="apf__pane-title">待添加 {pending.length ? `· ${pending.length}` : ''}</span>
              {pending.length > 0 && (
                <button type="button" className="ap__lib-link" onClick={resetQueue}>清空</button>
              )}
            </div>
            <div className="apf__pane-body">
            {pending.length === 0 ? (
              <p className="apf__empty">从左侧选择图片，或拖拽文件进来</p>
            ) : (
              <ul className="ap__queue">
                {pending.map((item, i) => (
                  <li key={item.localId} className="ap__queue-item">
                    <div className="ap__queue-thumb">
                      <img src={item.preview} alt="" />
                      {item.remoteUrl && <span className="ap__queue-badge">链接</span>}
                    </div>
                    <label className="ap__label ap__queue-title">
                      标题 {pending.length > 1 ? `${i + 1}` : ''} <span className="ap__required">*</span>
                      <input
                        className="ap__input"
                        value={item.title}
                        onChange={e => setPending(prev =>
                          prev.map(p => p.localId === item.localId ? { ...p, title: e.target.value } : p)
                        )}
                        placeholder="这张照片叫什么"
                        maxLength={40}
                      />
                    </label>
                    <button
                      type="button"
                      className="ap__item-del"
                      onClick={() => setPending(prev => prev.filter(p => p.localId !== item.localId))}
                      aria-label={`移除 ${item.title || '这张图'}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            </div>

            <div className="apf__rail-foot">
              <div className={`ap__form ${pending.length === 0 ? 'ap__form--hidden' : ''}`}>
              <p className="apf__hint" style={{ marginBottom: 10 }}>以下对这一批共用</p>
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
              <button className="ap__submit" onClick={handleUpload}
                disabled={uploading || !canSubmit}>
                {uploading
                  ? <><span className="ap__spinner" /> 处理中…</>
                  : `确认添加 ${pending.length} 张`}
              </button>
              </div>
              {status && (
                <p className={status.type === 'err' ? 'ap__err' : 'ap__ok'}>{status.msg}</p>
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div className="apf__main apf__main--single">
          <section className="apf__pane">
            <div className="apf__pane-head">
              <span className="apf__pane-title">已发布</span>
              <span className="apf__hint">共 {uploadedPhotos.length} 张 · 星标为首屏背景</span>
            </div>
            <div className="apf__pane-body">
              {status && (
                <p className={status.type === 'err' ? 'ap__err' : 'ap__ok'}
                  style={{ marginBottom: 12 }}>{status.msg}</p>
              )}
              {uploadedPhotos.length === 0 ? (
                <p className="apf__empty">还没有通过面板发布的作品</p>
              ) : (
                <ul className="ap__list">
                  {uploadedPhotos.map((p, i) => {
                    const isCover = p.cover || (!uploadedPhotos.some(x => x.cover) && i === 0);
                    return (
                    <li key={p.id} className="ap__item">
                      <div className="ap__item-thumb"><img src={p.src} alt={p.title} loading="lazy" /></div>
                      <div className="ap__item-info">
                        <span className="ap__item-title">{p.title}</span>
                        <span className="ap__item-meta">
                          {[p.location, p.year, p.span].filter(Boolean).join(' · ')}
                          {isCover && <span className="ap__cover-tag">首屏背景</span>}
                        </span>
                      </div>
                      <button
                        className={`ap__item-star ${isCover ? 'ap__item-star--on' : ''}`}
                        onClick={() => void handleSetCover(p)}
                        disabled={coverBusy !== null || Boolean(p.cover)}
                        title={p.cover ? '当前首屏背景' : '设为首屏背景'}
                        aria-label={p.cover ? '当前首屏背景' : `把 ${p.title} 设为首屏背景`}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24"
                          fill={isCover ? 'currentColor' : 'none'}
                          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="12 3 14.9 9.2 21.5 10 16.7 14.6 17.9 21.2 12 18 6.1 21.2 7.3 14.6 2.5 10 9.1 9.2" />
                        </svg>
                      </button>
                      <button className="ap__item-del" onClick={() => handleDelete(p)} aria-label={`删除 ${p.title}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6M9 6V4h6v2" />
                        </svg>
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
