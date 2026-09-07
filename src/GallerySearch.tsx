/**
 * 画廊检索条 —— 访客侧的语义搜索 + 主题 chip。
 *
 * 输入词走 Chinese-CLIP 文本塔（首次用到才下载权重），和写在 photos.json 里的
 * 图像向量比余弦；没跑过分析的图库退化成标题/地点/标签的子串筛选。
 * 组件自己不渲染结果，算完把列表交给 onFiltered，排布和空态都归画廊管。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Photo } from './data';
import { filterByChip, localScore, rankPhotos, THEME_LABELS } from './ml/search';

/** 中文输入法一个词往往要敲好几下，等手停下来再检索 */
const DEBOUNCE_MS = 280;
const NO_VECTOR_NOTE = '未分析的照片只按标题筛选';

interface GallerySearchProps {
  photos: Photo[];
  onFiltered: (list: Photo[]) => void;
}

export function GallerySearch({ photos, onFiltered }: GallerySearchProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [chip,  setChip]  = useState('');
  const [note,  setNote]  = useState('');
  const [failed, setFailed] = useState(false);
  const [busy,   setBusy]   = useState(false);
  // onFiltered 大概率是每次渲染新建的闭包，放进 effect 依赖会来回打转
  const emitRef = useRef(onFiltered);

  useEffect(() => { emitRef.current = onFiltered; }, [onFiltered]);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [input]);

  const hasVectors = useMemo(() => photos.some(p => p.embedding?.length), [photos]);

  useEffect(() => {
    const emit = emitRef.current;
    const base = chip ? filterByChip(photos, chip) : photos;

    if (!query) {
      setBusy(false);
      setFailed(false);
      setNote('');
      emit(base);
      return;
    }

    let alive = true;
    setBusy(true);
    setFailed(false);
    setNote(hasVectors ? '正在检索…' : NO_VECTOR_NOTE);

    void rankPhotos(base, query, msg => { if (alive) setNote(msg); })
      .then(ranked => {
        if (!alive) return;
        setBusy(false);
        // 有向量时 rankPhotos 是「重排」，全部留下，最像的排在最前；
        // 没有向量时它只按子串得分排序，这里收紧成筛选，不然搜索等于没搜
        emit(hasVectors ? ranked : ranked.filter(p => localScore(p, query) > 0));
        setNote(hasVectors ? '' : NO_VECTOR_NOTE);
      })
      .catch(() => {
        if (!alive) return;
        setBusy(false);
        setFailed(true);
        setNote('语义检索没能启动，已退回按标题筛选');
        emit(base.filter(p => localScore(p, query) > 0));
      });

    return () => { alive = false; };
  }, [photos, query, chip, hasVectors]);

  const clear = useCallback(() => { setInput(''); setQuery(''); }, []);

  return (
    <div className="gsearch">
      <div className="gsearch__row">
        <div className={`gsearch__field ${busy ? 'gsearch__field--busy' : ''}`}>
          <svg className="gsearch__icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <line x1="15.5" y1="15.5" x2="20" y2="20" />
          </svg>
          <input
            className="gsearch__input"
            type="search"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="搜雾、红墙、人像…"
            aria-label="搜索作品"
            autoComplete="off"
          />
          {input && (
            <button className="gsearch__clear" onClick={clear} aria-label="清空检索词">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        <div className="gsearch__chips" role="group" aria-label="主题">
          {THEME_LABELS.map(label => (
            <button
              key={label}
              className={`gsearch__chip ${chip === label ? 'gsearch__chip--on' : ''}`}
              aria-pressed={chip === label}
              onClick={() => setChip(c => (c === label ? '' : label))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {note && (
        <p className={`gsearch__note ${failed ? 'gsearch__note--warn' : ''}`} role="status">
          {note}
        </p>
      )}
    </div>
  );
}
