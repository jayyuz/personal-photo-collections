/**
 * pack — 让 bento 网格尽量密铺
 *
 * 浏览器自带的 grid-auto-flow: dense 只会「拿后面的小图去补前面的洞」，
 * 一旦后面的图都塞不进那个洞，洞就留下了。这里在渲染前先按当前列数模拟排布：
 * 每次取最靠前的空格，从紧随其后的若干张里挑一张放进去，把大图凑到同一行、
 * 1×1 的图留着收尾，再用同一套 dense 规则复算一遍，多套策略里挑洞最少的那种。
 *
 * 排出来的顺序交给浏览器摆放，结果和这里的模拟一致。
 * 顺序只在渲染时算，不写回 photos.json，原顺序（策展顺序）仍然保留。
 */
import { useEffect, useState } from 'react';
import type { Photo, PhotoSpan } from './data';

/** 与 index.css 的断点保持一致：>1200 四列，901–1200 三列，≤900 两列 */
export function useGridColumns(): number {
  const [cols, setCols] = useState(() => {
    if (typeof window === 'undefined') return 4;
    return window.innerWidth > 1200 ? 4 : window.innerWidth > 900 ? 3 : 2;
  });

  useEffect(() => {
    const q4 = window.matchMedia('(min-width: 1201px)');
    const q3 = window.matchMedia('(min-width: 901px)');
    const sync = () => setCols(q4.matches ? 4 : q3.matches ? 3 : 2);
    sync();
    q4.addEventListener('change', sync);
    q3.addEventListener('change', sync);
    return () => {
      q4.removeEventListener('change', sync);
      q3.removeEventListener('change', sync);
    };
  }, []);

  return cols;
}

export interface TileSize {
  cols: number;
  rows: number;
}

const TILE: Record<PhotoSpan, TileSize> = {
  normal: { cols: 1, rows: 1 },
  wide:   { cols: 2, rows: 1 },
  tall:   { cols: 1, rows: 2 },
  big:    { cols: 2, rows: 2 },
};

export function tileOf(span?: PhotoSpan): TileSize {
  return TILE[span ?? 'normal'] ?? TILE.normal;
}

const area = (t: TileSize) => t.cols * t.rows;

type Pref = 'large' | 'small' | 'fit';

/**
 * 单套策略的参数：
 * window  — 只在后面这么多张里挑，越小越接近原顺序
 * pref    — 挑大图（凑同行）/ 挑小图（先补缝）/ 优先正好填满当前空位
 */
const STRATEGIES: { window: number; pref: Pref }[] = [
  { window: Number.POSITIVE_INFINITY, pref: 'large' },
  { window: 8,                        pref: 'large' },
  { window: 4,                        pref: 'large' },
  { window: Number.POSITIVE_INFINITY, pref: 'fit'   },
  { window: 8,                        pref: 'fit'   },
  { window: 8,                        pref: 'small' },
];

export interface PackResult {
  /** 排好序的照片，直接按这个顺序渲染 */
  order:    Photo[];
  /** 最后一行之前的空洞，几何上凑不出完美密铺时可能大于 0 */
  holes:    number;
  /** 最后一行尾部的空格，总面积凑不满整行时必然出现 */
  trailing: number;
  rows:     number;
}

interface Sim {
  rows:     number;
  holes:    number;
  trailing: number;
}

const key = (r: number, c: number) => `${r}:${c}`;

/** 完整复刻浏览器的 grid-auto-flow: row dense，用来评估结果 */
function simulate(sizes: TileSize[], cols: number): Sim {
  const occ = new Set<string>();
  const free = (r: number, c: number) => !occ.has(key(r, c));
  let rows = 1;

  for (const t of sizes) {
    for (let r = 0; r <= rows + 1; r++) {
      let placed = false;
      for (let c = 0; c + t.cols <= cols; c++) {
        let ok = true;
        for (let dr = 0; dr < t.rows; dr++) {
          for (let dc = 0; dc < t.cols; dc++) if (!free(r + dr, c + dc)) ok = false;
        }
        if (!ok) continue;
        for (let dr = 0; dr < t.rows; dr++) {
          for (let dc = 0; dc < t.cols; dc++) occ.add(key(r + dr, c + dc));
        }
        rows = Math.max(rows, r + t.rows);
        placed = true;
        break;
      }
      if (placed) break;
    }
  }

  let holes = 0;
  let trailing = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!free(r, c)) continue;
      if (r < rows - 1) holes += 1;
      else trailing += 1;
    }
  }
  return { rows, holes, trailing };
}

/** 按某种偏好把 tiles 重排成一个顺序，返回原始下标序列 */
function greedyOrder(sizes: TileSize[], cols: number, window: number, pref: Pref): number[] {
  const occ = new Set<string>();
  const free = (r: number, c: number) => !occ.has(key(r, c));
  const fits = (t: TileSize, r: number, c: number) => {
    if (c + t.cols > cols) return false;
    for (let dr = 0; dr < t.rows; dr++) {
      for (let dc = 0; dc < t.cols; dc++) if (!free(r + dr, c + dc)) return false;
    }
    return true;
  };

  const remaining = sizes.map((size, index) => ({ size, index }));
  const order: number[] = [];
  let rows = 0;
  const maxIter = sizes.length * 4 + cols * 2 + 8;

  const score = (t: TileSize, run: number) => {
    if (pref === 'large') return -area(t);
    if (pref === 'small') return area(t);
    return (t.cols === run ? 0 : 100) - area(t);
  };

  for (let guard = 0; remaining.length && guard < maxIter; guard++) {
    // 最靠前的空格；当前所有行都满了就另起一行
    let r = rows, c = 0, found = false;
    for (let rr = 0; rr < rows && !found; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        if (free(rr, cc)) { r = rr; c = cc; found = true; break; }
      }
    }
    // 这个空格往后连续几列是空的，正好填满它的优先
    let run = 0;
    while (c + run < cols && free(r, c + run)) run += 1;

    let pick = -1;
    const end = Math.min(window, remaining.length);
    for (let i = 0; i < end; i++) {
      if (!fits(remaining[i].size, r, c)) continue;
      if (pick < 0 || score(remaining[i].size, run) < score(remaining[pick].size, run)) pick = i;
    }
    // 窗口里都放不下，就在剩下的全部里找最早能放下的
    if (pick < 0) pick = remaining.findIndex(t => fits(t.size, r, c));

    if (pick < 0) {
      // 没有任何一张塞得进这个格子，只能留空
      occ.add(key(r, c));
      continue;
    }

    const [chosen] = remaining.splice(pick, 1);
    for (let dr = 0; dr < chosen.size.rows; dr++) {
      for (let dc = 0; dc < chosen.size.cols; dc++) occ.add(key(r + dr, c + dc));
    }
    rows = Math.max(rows, r + chosen.size.rows);
    order.push(chosen.index);
  }

  // 兜底：极端情况下没排完的直接追加，保证一张不丢
  for (const t of remaining) order.push(t.index);
  return order;
}

/** 相对原顺序的位移总和，越小越贴近策展顺序 */
function displacement(order: number[]): number {
  let sum = 0;
  order.forEach((original, pos) => { sum += Math.abs(pos - original); });
  return sum;
}

function better(sim: Sim, dist: number, bestSim: Sim, bestDist: number): boolean {
  if (sim.holes    !== bestSim.holes)    return sim.holes    < bestSim.holes;
  if (sim.trailing !== bestSim.trailing) return sim.trailing < bestSim.trailing;
  return dist < bestDist;
}

export function packPhotos(photos: Photo[], columns: number): PackResult {
  const cols = Math.max(1, Math.floor(columns));
  if (!photos.length) return { order: [], holes: 0, trailing: 0, rows: 0 };

  const sizes  = photos.map(p => tileOf(p.span));
  const identity = photos.map((_, i) => i);
  let bestOrder = identity;
  let bestSim   = simulate(sizes, cols);
  let bestDist  = 0;

  for (const s of STRATEGIES) {
    const order = greedyOrder(sizes, cols, s.window, s.pref);
    if (order.length !== photos.length) continue;
    const sim  = simulate(order.map(i => sizes[i]), cols);
    const dist = displacement(order);
    if (better(sim, dist, bestSim, bestDist)) {
      bestOrder = order; bestSim = sim; bestDist = dist;
    }
  }

  return {
    order:    bestOrder.map(i => photos[i]),
    holes:    bestSim.holes,
    trailing: bestSim.trailing,
    rows:     bestSim.rows,
  };
}
