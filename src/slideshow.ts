/**
 * 浏览模式（幻灯片）的配置：切换动画 + 自动切换速度。
 *
 * 这里是纯配置与纯函数，不碰 React：动画的实际渲染在 Lightbox 里（给大图挂
 * 一个 animation-name），轮播的定时在 App 里（它才知道当前翻到第几张）。
 */

/** 「随机」也是选项之一，表示每次切换临时抽一个 */
export type SlideEffect =
  | 'fade' | 'slide' | 'rise' | 'zoomIn' | 'zoomOut' | 'flip' | 'focus' | 'random';

/** 真正能落到画面上的动画，不含 random */
export type ConcreteEffect = Exclude<SlideEffect, 'random'>;

export interface SlideEffectOption { id: SlideEffect; label: string }

/** 顺序即 UI 上的顺序；random 放最后 */
export const SLIDE_EFFECTS: SlideEffectOption[] = [
  { id: 'fade',    label: '淡入淡出' },
  { id: 'slide',   label: '横向推移' },
  { id: 'rise',    label: '上浮' },
  { id: 'zoomIn',  label: '放大进入' },
  { id: 'zoomOut', label: '缩小进入' },
  { id: 'flip',    label: '立体翻页' },
  { id: 'focus',   label: '对焦' },
  { id: 'random',  label: '随机' },
];

/** 抽签用的候选，和上面的列表要保持一致 */
const PICKABLE: readonly ConcreteEffect[] =
  ['fade', 'slide', 'rise', 'zoomIn', 'zoomOut', 'flip', 'focus'];

export interface SlideSpeedOption { ms: number; label: string }

export const SLIDE_SPEEDS: SlideSpeedOption[] = [
  { ms: 2000,  label: '2 秒' },
  { ms: 3500,  label: '3.5 秒' },
  { ms: 5000,  label: '5 秒' },
  { ms: 8000,  label: '8 秒' },
  { ms: 12000, label: '12 秒' },
];

export const DEFAULT_EFFECT: SlideEffect = 'random';
export const DEFAULT_SPEED_MS = 5000;

export interface SlideshowState {
  /** 是否正在自动播放 */
  playing: boolean;
  /** 切换动画；random 表示每次现抽 */
  effect: SlideEffect;
  /** 每张停留多久（毫秒） */
  speedMs: number;
}

export const DEFAULT_SLIDESHOW: SlideshowState = {
  playing: false,
  effect:  DEFAULT_EFFECT,
  speedMs: DEFAULT_SPEED_MS,
};

/** 把 random 解析成这次真正要用的动画 */
export function resolveEffect(effect: SlideEffect): ConcreteEffect {
  if (effect !== 'random') return effect;
  return PICKABLE[Math.floor(Math.random() * PICKABLE.length)];
}

export function effectLabel(id: SlideEffect): string {
  return SLIDE_EFFECTS.find(e => e.id === id)?.label ?? id;
}

const KEY = 'pp.slideshow.v1';

/**
 * 动画和速度记在本地，下次进来接着用。
 * playing 不记：刷新后停在灯箱里自己转起来会很意外。
 */
export function loadSlideshow(): SlideshowState {
  if (typeof localStorage === 'undefined') return DEFAULT_SLIDESHOW;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SLIDESHOW;
    const p = JSON.parse(raw) as Partial<SlideshowState>;
    const effect  = SLIDE_EFFECTS.some(e => e.id === p.effect)   ? p.effect!  : DEFAULT_EFFECT;
    const speedMs = SLIDE_SPEEDS.some(s => s.ms === p.speedMs)   ? p.speedMs! : DEFAULT_SPEED_MS;
    return { playing: false, effect, speedMs };
  } catch {
    return DEFAULT_SLIDESHOW;
  }
}

export function saveSlideshow(s: SlideshowState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ effect: s.effect, speedMs: s.speedMs }));
  } catch { /* 隐私模式下写不了，忽略 */ }
}
