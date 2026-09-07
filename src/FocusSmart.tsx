import { useState } from 'react';
import type { Photo, PhotoFocus } from './data';
import { aestheticFromImage, focusFromImage, suggestCoverId } from './ml/focus';

type StatusMsg = { type: 'ok' | 'err'; msg: string } | null;

export type FocusPatch = {
  focus?: PhotoFocus;
  aesthetic?: number;
};

export function QueueFocus({
  items,
  disabled,
  onPatch,
  onStatus,
}: {
  items: { localId: string; preview: string }[];
  disabled?: boolean;
  onPatch: (localId: string, patch: FocusPatch) => void;
  onStatus: (msg: StatusMsg) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!items.length || busy) return;
    setBusy(true);
    let failed = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        onStatus({ type: 'ok', msg: `主体焦点 ${i + 1}/${items.length}…` });
        try {
          const focus = await focusFromImage(item.preview, msg => onStatus({ type: 'ok', msg }));
          const aesthetic = await aestheticFromImage(item.preview, msg => onStatus({ type: 'ok', msg }));
          onPatch(item.localId, { focus, aesthetic });
        } catch (e) {
          failed += 1;
          onStatus({
            type: 'err',
            msg: `主体焦点失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (failed === 0) {
        onStatus({ type: 'ok', msg: `已完成主体焦点 ${items.length} 张` });
      } else if (failed < items.length) {
        onStatus({
          type: 'err',
          msg: `主体焦点完成 ${items.length - failed}/${items.length} 张，${failed} 张失败`,
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
      {busy ? '焦点分析中…' : '主体焦点'}
    </button>
  );
}

export function PublishedFocus({
  photos,
  disabled,
  onStatus,
  persist,
  onUpdate,
  onSetCover,
}: {
  photos: Photo[];
  disabled?: boolean;
  onStatus: (msg: StatusMsg) => void;
  persist: (next: Photo[], message: string) => Promise<void>;
  onUpdate: (list: Photo[]) => void;
  onSetCover: (photo: Photo) => void;
}) {
  const [busy, setBusy] = useState(false);

  const coverId = photos.find(p => p.cover)?.id ?? photos[0]?.id;
  const suggestedId = suggestCoverId(photos);
  const suggested =
    suggestedId && suggestedId !== coverId
      ? photos.find(p => p.id === suggestedId)
      : undefined;

  const run = async () => {
    if (busy) return;
    const missing = photos.filter(p => !p.focus || p.aesthetic == null);
    if (!missing.length) {
      onStatus({
        type: 'ok',
        msg: suggested
          ? '主体与封面分已齐全'
          : '主体与封面分已齐全，当前封面已是最高分',
      });
      return;
    }
    setBusy(true);
    let next = photos;
    let failed = 0;
    try {
      for (let i = 0; i < missing.length; i++) {
        const p = missing[i];
        onStatus({ type: 'ok', msg: `主体与封面分 ${i + 1}/${missing.length}：${p.title}` });
        try {
          const patch: FocusPatch = {};
          if (!p.focus) {
            patch.focus = await focusFromImage(p.src, msg => onStatus({ type: 'ok', msg }));
          }
          if (p.aesthetic == null) {
            patch.aesthetic = await aestheticFromImage(p.src, msg => onStatus({ type: 'ok', msg }));
          }
          next = next.map(x => x.id === p.id ? { ...x, ...patch } : x);
          onUpdate(next);
        } catch (e) {
          failed += 1;
          onStatus({
            type: 'err',
            msg: `「${p.title}」分析失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      await persist(next, `🎯 Focus & aesthetic for ${missing.length - failed} photo(s)`);
      if (failed === 0) {
        onStatus({ type: 'ok', msg: `已写入主体与封面分 ${missing.length} 张` });
      } else if (failed < missing.length) {
        onStatus({
          type: 'err',
          msg: `已写入 ${missing.length - failed}/${missing.length} 张，${failed} 张失败`,
        });
      }
    } catch (e) {
      onStatus({ type: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="apf__mini"
        disabled={disabled || busy || photos.length === 0}
        onClick={() => void run()}
      >
        {busy ? '分析中…' : '主体与封面分'}
      </button>
      {suggested && (
        <span className="apf__focus-suggest">
          建议封面：{suggested.title}
          <button
            type="button"
            className="apf__mini"
            disabled={disabled || busy}
            onClick={() => onSetCover(suggested)}
          >
            采用
          </button>
        </span>
      )}
    </>
  );
}
