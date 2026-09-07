/** 画廊悬停叠色 — 和 About 文案里的四类气质对应 */
export const TINT_OPTS = [
  { label: '人物 · 暖红',  value: 'rgba(220,80,60,0.25)',    hues: [0, 25] as [number, number] },
  { label: '人文 · 琥珀',  value: 'rgba(200,120,20,0.22)',   hues: [18, 48] as [number, number] },
  { label: '花朵 · 洋红',  value: 'rgba(220,40,180,0.22)',   hues: [280, 340] as [number, number] },
  { label: '风景 · 靛蓝',  value: 'rgba(40,120,200,0.22)',   hues: [190, 250] as [number, number] },
  { label: '暮色 · 深紫',  value: 'rgba(80,40,160,0.25)',    hues: [250, 290] as [number, number] },
  { label: '清爽 · 翠绿',  value: 'rgba(40,160,100,0.22)',   hues: [90, 160] as [number, number] },
  { label: '极光 · 玫瑰',  value: 'rgba(200,40,120,0.22)',   hues: [320, 20] as [number, number] },
  { label: '中性 · 灰调',  value: 'rgba(180,180,180,0.22)',  hues: null },
] as const;

export const DEFAULT_TINT = TINT_OPTS[0].value;
