/**
 * 画廊检索条 —— 主题 chip + 标题/标签/地点匹配。
 *
 * 全部在本地同步算完，访客不下载任何模型：标签是 Admin 侧用 MobileCLIP
 * 打好后写进 photos.json 的。组件自己不渲染结果，算完把列表交给 onFiltered，
 * 排布和空态都归画廊管。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Photo } from './data';
import { availableThemes, filterByChip, searchPhotos } from './ml/search';

/** 中文输入法一个词往往要敲好几下，等手停下来再筛 */
const DEBOUNCE_MS = 200;

interface GallerySearchProps {
  photos: Photo[];
  onFiltered: (list: Photo[]) => void;
}

export function GallerySearch({ photos, onFiltered }: GallerySearchProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [chip,  setChip]  = useState('');
  // onFiltered 大概率是每次渲染新建的闭包，放进 effect 依赖会来回打转
  const emitRef = useRef(onFiltered);

  useEffect(() => { emitRef.current = onFiltered; }, [onFiltered]);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [input]);

  const themes = useMemo(() => availableThemes(photos), [photos]);

  // 重新打标之后某个主题可能整个消失，别把画廊卡在空结果上
  useEffect(() => {
    if (chip && !themes.some(t => t === chip)) setChip('');
  }, [chip, themes]);

  // 没筛的时候原样把 photos 传回去，App 靠引用相等判断当前有没有在筛
  const result = useMemo(() => {
    const base = chip ? filterByChip(photos, chip) : photos;
    return searchPhotos(base, query);
  }, [photos, chip, query]);

  useEffect(() => { emitRef.current(result); }, [result]);

  const clear = useCallback(() => { setInput(''); setQuery(''); }, []);

  const filtering = result !== photos;

  return (
    <div className="gsearch">
      <div className="gsearch__row">
        <div className="gsearch__field">
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
            placeholder="搜标题、地点、标签…"
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
        {themes.length > 0 && (
          <div className="gsearch__chips" role="group" aria-label="主题">
            {themes.map(label => (
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
        )}
      </div>
      {filtering && result.length > 0 && (
        <p className="gsearch__note" role="status">筛出 {result.length} 张</p>
      )}
    </div>
  );
}
