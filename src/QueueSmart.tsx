import { useState } from 'react';
import type { Photo } from './data';
import { embedImage, scoreLabels } from './ml/clip';
import { THEME_LABELS, isGenericTitle, pickTags, titleFromTags } from './ml/tagging';
import { tintFromImage } from './ml/palette';

export type QueuePatch = {
  title?: string;
  tags?: string[];
  tint?: string;
  embedding?: number[];
};

export function QueueSmart({
  items,
  disabled,
  onPatch,
  onStatus,
}: {
  items: { localId: string; title: string; preview: string }[];
  disabled?: boolean;
  onPatch: (localId: string, patch: QueuePatch) => void;
  onStatus: (msg: { type: 'ok' | 'err'; msg: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!items.length || busy) return;
    setBusy(true);
    let failed = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        onStatus({ type: 'ok', msg: `分析 ${i + 1}/${items.length}：${item.title}…` });
        try {
          const embedding = await embedImage(item.preview);
          const scored = await scoreLabels(embedding, THEME_LABELS);
          const tags = pickTags(scored);
          let tint: string | undefined;
          try {
            tint = await tintFromImage(item.preview);
          } catch {
            /* 取色失败不影响标签 */
          }
          const patch: QueuePatch = { tags, embedding };
          if (tint) patch.tint = tint;
          if (isGenericTitle(item.title)) {
            patch.title = titleFromTags(tags, item.title);
          }
          onPatch(item.localId, patch);
        } catch (e) {
          failed += 1;
          onStatus({
            type: 'err',
            msg: `「${item.title}」分析失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (failed === 0) {
        onStatus({ type: 'ok', msg: `已分析 ${items.length} 张：标签与色调` });
      } else if (failed < items.length) {
        onStatus({
          type: 'err',
          msg: `完成 ${items.length - failed}/${items.length} 张，${failed} 张失败`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="apf__mini"
      disabled={disabled || busy || items.length === 0}
      onClick={() => void run()}
    >
      {busy ? '分析中…' : '标签与色调'}
    </button>
  );
}

/** 给已经发布、尚未分析的旧照片补齐语义索引和标签。 */
export function PublishedSmart({
  photos,
  disabled,
  onStatus,
  persist,
  onUpdate,
}: {
  photos: Photo[];
  disabled?: boolean;
  onStatus: (msg: { type: 'ok' | 'err'; msg: string } | null) => void;
  persist: (next: Photo[], message: string) => Promise<void>;
  onUpdate: (photos: Photo[]) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    const missing = photos.filter(p => !p.embedding?.length || !p.tags?.length);
    if (!missing.length) {
      onStatus({ type: 'ok', msg: '所有照片都已有语义索引' });
      return;
    }

    setBusy(true);
    let next = photos;
    let succeeded = 0;
    try {
      for (let i = 0; i < missing.length; i++) {
        const photo = missing[i];
        onStatus({ type: 'ok', msg: `语义索引 ${i + 1}/${missing.length}：${photo.title}` });
        try {
          const embedding = await embedImage(photo.src, msg =>
            onStatus({ type: 'ok', msg }),
          );
          const scored = await scoreLabels(embedding, THEME_LABELS);
          const tags = pickTags(scored);
          next = next.map(p => p.id === photo.id ? { ...p, embedding, tags } : p);
          onUpdate(next);
          succeeded += 1;
        } catch (e) {
          onStatus({
            type: 'err',
            msg: `「${photo.title}」索引失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      if (succeeded) {
        await persist(next, `🔎 Semantic index for ${succeeded} photo(s)`);
      }
      onStatus({
        type: succeeded === missing.length ? 'ok' : 'err',
        msg: `语义索引完成 ${succeeded}/${missing.length} 张`,
      });
    } catch (e) {
      onStatus({ type: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const missingCount = photos.filter(p => !p.embedding?.length || !p.tags?.length).length;
  return (
    <button
      type="button"
      className="apf__mini"
      disabled={disabled || busy || photos.length === 0}
      onClick={() => void run()}
      title={`为旧照片补齐标签和 Chinese-CLIP 向量${missingCount ? `（${missingCount} 张）` : ''}`}
    >
      {busy ? '索引中…' : `语义索引${missingCount ? ` · ${missingCount}` : ''}`}
    </button>
  );
}
