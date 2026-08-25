/**
 * EXIF 提取与展示
 *
 * 优先从本地原文件读（上传时）。网络图也可以读：浏览器 fetch 图片再解析，
 * 或用 Cloudinary Admin API 的 image_metadata。能否读到取决于远端是否还保留元数据——
 * Cloudinary 默认投递会剥掉 EXIF，所以会尽量请求「无变换 / fl_keep_iptc」版本。
 */
import type { PhotoExif } from './data';

const PICK = [
  'Make', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat',
  'FNumber', 'ExposureTime', 'ISO', 'ISOSpeedRatings',
  'DateTimeOriginal', 'CreateDate',
  'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight',
  'ExposureBiasValue', 'WhiteBalance',
];
const LS_CONFIG_KEY = 'photo-admin-config-v1';

type RawExif = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.includes('/')) {
    const [a, b] = v.split('/').map(Number);
    if (b) return a / b;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (Array.isArray(v) && v.length) return num(v[0]);
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** Make 常包含品牌，Model 有时会重复品牌名，合并时去重 */
function joinCamera(make?: string, model?: string): string | undefined {
  if (!make) return model;
  if (!model) return make;
  const brand = make.split(/\s+/)[0];
  return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${make} ${model}`;
}

function toExif(raw: RawExif | undefined | null): PhotoExif | undefined {
  if (!raw) return undefined;
  const exif: PhotoExif = {
    camera:   joinCamera(str(raw.Make), str(raw.Model)),
    lens:     str(raw.LensModel) ?? str(raw.Lens),
    focal:    num(raw.FocalLength) ?? num(raw.FocalLengthIn35mmFormat),
    aperture: num(raw.FNumber) ?? num(raw.ApertureValue),
    shutter:  num(raw.ExposureTime) ?? num(raw.ShutterSpeedValue),
    iso:      num(raw.ISO) ?? num(raw.ISOSpeedRatings) ?? num(raw.PhotographicSensitivity),
    width:    num(raw.ExifImageWidth) ?? num(raw.ImageWidth) ?? num(raw.width),
    height:   num(raw.ExifImageHeight) ?? num(raw.ImageHeight) ?? num(raw.height),
    ev:       num(raw.ExposureBiasValue) ?? num(raw.ExposureBias),
  };
  const shot = raw.DateTimeOriginal ?? raw.CreateDate ?? raw.datetime_original;
  if (shot instanceof Date && !Number.isNaN(shot.getTime())) {
    exif.shotAt = shot.toISOString();
  } else if (typeof shot === 'string' && shot.trim()) {
    const d = new Date(shot.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    if (!Number.isNaN(d.getTime())) exif.shotAt = d.toISOString();
  }
  return Object.values(exif).some(v => v !== undefined) ? exif : undefined;
}

async function parseWithExifr(source: File | Blob | ArrayBuffer): Promise<PhotoExif | undefined> {
  try {
    const { default: exifr } = await import('exifr');
    return toExif(await exifr.parse(source, { pick: PICK, reviveValues: true }));
  } catch {
    return undefined;
  }
}

/** 去掉 f_auto / 缩放等变换，尽量回到接近原图的投递地址 */
export function originalDeliveryUrl(url: string): string {
  return url.replace(/\/upload\/(?:[^/]*f_auto[^/]*|fl_keep_iptc[^/]*)\//, '/upload/');
}

/** 投递地址带 fl_keep_iptc，部分账号会因此保留元数据 */
export function metadataUrl(url: string): string {
  const original = originalDeliveryUrl(url);
  if (original.includes('/upload/fl_keep_iptc/')) return original;
  return original.replace('/upload/', '/upload/fl_keep_iptc/');
}

function candidateUrls(url: string): string[] {
  const original = originalDeliveryUrl(url);
  const keep = metadataUrl(url);
  return [...new Set([original, keep, url])];
}

function extractPublicId(url: string): string | undefined {
  const m = url.match(/\/(?:image|video)\/upload\/(?:(?:v\d+|[^/]*f_auto[^/]*|fl_keep_iptc[^/]*)\/)*(?:v\d+\/)?(.+?)$/i);
  if (!m) return undefined;
  return m[1].replace(/\.[a-z0-9]+$/i, '');
}

function extractCloudName(url: string): string | undefined {
  return url.match(/res\.cloudinary\.com\/([^/]+)/)?.[1];
}

async function fetchBlob(url: string): Promise<Blob | undefined> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size < 32) return undefined;
    return blob;
  } catch {
    return undefined;
  }
}

async function readExifFromAdminApi(imageUrl: string): Promise<PhotoExif | undefined> {
  try {
    const raw = localStorage.getItem(LS_CONFIG_KEY);
    if (!raw) return undefined;
    const cfg = JSON.parse(raw) as { apiKey?: string; apiSecret?: string; cloudName?: string };
    const key = cfg.apiKey?.trim();
    const secret = cfg.apiSecret?.trim();
    if (!key || !secret) return undefined;
    const cloud = extractCloudName(imageUrl) ?? cfg.cloudName?.trim();
    const publicId = extractPublicId(imageUrl);
    if (!cloud || !publicId) return undefined;
    const q = new URLSearchParams({ image_metadata: 'true', exif: 'true' });
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/image/upload/${encodeURIComponent(publicId)}?${q}`,
      { headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` } }
    );
    if (!res.ok) return undefined;
    const data = await res.json();
    const nested = (data.image_metadata ?? data.exif ?? data) as RawExif;
    return toExif({
      ...nested,
      width:  nested.width ?? data.width,
      height: nested.height ?? data.height,
    });
  } catch {
    return undefined;
  }
}

export async function readExif(source: File | Blob | string): Promise<PhotoExif | undefined> {
  if (typeof source === 'string') return readExifFromUrl(source);
  return parseWithExifr(source);
}

/** 从网络图片地址解析 EXIF：先拉原图字节，再尝试 Cloudinary Admin API */
export async function readExifFromUrl(url: string): Promise<PhotoExif | undefined> {
  for (const candidate of candidateUrls(url)) {
    const blob = await fetchBlob(candidate);
    if (!blob) continue;
    const parsed = await parseWithExifr(blob);
    if (parsed) return parsed;
  }
  return readExifFromAdminApi(url);
}

function fmtShutter(s: number): string {
  if (s >= 1) return `${Number(s.toFixed(1))} s`;
  return `1/${Math.round(1 / s)} s`;
}

/** 转成右侧面板要展示的「标签 → 文本」列表 */
export function exifRows(exif: PhotoExif): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value?: string) => { if (value) rows.push({ label, value }); };

  push('相机', exif.camera);
  push('镜头', exif.lens);
  push('焦距', exif.focal !== undefined ? `${Math.round(exif.focal)} mm` : undefined);
  push('光圈', exif.aperture !== undefined ? `f/${Number(exif.aperture.toFixed(1))}` : undefined);
  push('快门', exif.shutter !== undefined ? fmtShutter(exif.shutter) : undefined);
  push('ISO', exif.iso !== undefined ? String(exif.iso) : undefined);
  push('曝光补偿', exif.ev ? `${exif.ev > 0 ? '+' : ''}${Number(exif.ev.toFixed(1))} EV` : undefined);
  push('尺寸', exif.width && exif.height ? `${exif.width} × ${exif.height}` : undefined);

  if (exif.shotAt) {
    const d = new Date(exif.shotAt);
    if (!Number.isNaN(d.getTime())) {
      push('拍摄时间', d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }));
    }
  }
  return rows;
}
