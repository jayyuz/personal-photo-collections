/**
 * settings — VR 里的画质设置面板
 *
 * 画质只能在头显里边看边调：摩尔纹和锐度都得肉眼判断，
 * 退出 VR 改个 URL 再进来，刚才的观感早就忘了。
 *
 * 面板摆在视线下方、银幕前面：调的时候银幕仍然可见，改完立刻能对比。
 * 选项值都会存进 localStorage，下次进 VR 直接沿用。
 */
import * as THREE from 'three';

export interface VrSettings {
  /** 银幕视角大小倍率 —— 清晰度最直接的杠杆 */
  screenScale: number;
  /** 眼缓冲超采样倍率（需重进 VR） */
  renderScale: number;
  /** 纹理相对实际采样率的余量 */
  superSample: number;
  /** Cloudinary 服务端锐化强度 */
  sharpen: number;
  /** 取图方式：original=原图（默认，最稳），auto=按测量尺寸，或固定长边 */
  sourceMode: 'original' | 'auto' | 2048 | 3072 | 4096;
  /** 主图是否生成 mipmap */
  mipmaps: boolean;
  /** 固定注视点渲染强度 */
  foveation: number;
  /** 设备支持时是否使用原生合成层 */
  useLayers: boolean;
  /**
   * 强制指定眼缓冲宽度（像素，单眼）。0 = 交给倍率。
   * framebufferScaleFactor 在很多运行时会被封顶，直接指定尺寸是绕过它的办法。
   */
  forceWidth: 0 | 1920 | 2560 | 3200 | 3840;
  /** 是否显示诊断信息 */
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: VrSettings = {
  screenScale: 0.8,
  renderScale: 1.35,
  superSample: 1.06,
  sharpen:     25,
  sourceMode:  'original',
  mipmaps:     true,
  foveation:   0,
  useLayers:   true,
  forceWidth:  0,
  diagnostics: true,
};

type SettingValue = number | boolean | string;

interface SettingRow {
  key:     keyof VrSettings;
  label:   string;
  hint?:   string;
  options: { label: string; value: SettingValue }[];
}

const ROWS: SettingRow[] = [
  {
    key: 'screenScale',
    label: '银幕大小',
    hint: '越小越锐，提升最明显',
    options: [
      { label: '0.5',  value: 0.5  },
      { label: '0.65', value: 0.65 },
      { label: '0.8',  value: 0.8  },
      { label: '1.0',  value: 1.0  },
      { label: '1.2',  value: 1.2  },
    ],
  },
  {
    key: 'renderScale',
    label: '超采样',
    hint: '需重进 VR · 太高会掉帧',
    options: [
      { label: '1.0',  value: 1.0  },
      { label: '1.2',  value: 1.2  },
      { label: '1.35', value: 1.35 },
      { label: '1.5',  value: 1.5  },
      { label: '1.75', value: 1.75 },
      { label: '2.0',  value: 2.0  },
      { label: '2.5',  value: 2.5  },
      { label: '3.0',  value: 3.0  },
      { label: '4.0',  value: 4.0  },
    ],
  },
  {
    key: 'superSample',
    label: '纹理余量',
    hint: '大于 1 易摩尔纹，小于 1 发虚',
    options: [
      { label: '0.9',  value: 0.9  },
      { label: '1.0',  value: 1.0  },
      { label: '1.06', value: 1.06 },
      { label: '1.2',  value: 1.2  },
      { label: '1.4',  value: 1.4  },
    ],
  },
  {
    key: 'sharpen',
    label: '锐化',
    hint: '调大会同时放大摩尔纹',
    options: [
      { label: '关', value: 0  },
      { label: '15', value: 15 },
      { label: '25', value: 25 },
      { label: '40', value: 40 },
      { label: '60', value: 60 },
    ],
  },
  {
    key:   'sourceMode',
    label: '取图',
    hint: '原图最清晰；自动按测量尺寸',
    options: [
      { label: '原图',   value: 'original' },
      { label: '自动',   value: 'auto'     },
      { label: '2048',   value: 2048       },
      { label: '3072',   value: 3072       },
      { label: '4096',   value: 4096       },
    ],
  },
  {
    key: 'mipmaps',
    label: 'Mipmap',
    hint: '关掉可确认摩尔纹来源',
    options: [
      { label: '开', value: true  },
      { label: '关', value: false },
    ],
  },
  {
    key: 'foveation',
    label: '注视点渲染',
    hint: '省性能，但边缘会糊',
    options: [
      { label: '关', value: 0   },
      { label: '中', value: 0.5 },
      { label: '强', value: 1   },
    ],
  },
  {
    key:   'forceWidth',
    label: '强制缓冲',
    hint: '绕过被封顶的倍率 · 需重进VR',
    options: [
      { label: '自动',  value: 0    },
      { label: '1920',  value: 1920 },
      { label: '2560',  value: 2560 },
      { label: '3200',  value: 3200 },
      { label: '3840',  value: 3840 },
    ],
  },
  {
    key: 'useLayers',
    label: '原生合成层',
    hint: '设备支持时才会生效',
    options: [
      { label: '自动', value: true  },
      { label: '关',   value: false },
    ],
  },
  {
    key: 'diagnostics',
    label: '诊断信息',
    options: [
      { label: '显示', value: true  },
      { label: '隐藏', value: false },
    ],
  },
];

/* ---------- 存取 ---------- */
const STORAGE_KEY = 'vr-cinema-settings';

export function loadSettings(): VrSettings {
  const out = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const saved = JSON.parse(raw) as Partial<Record<keyof VrSettings, unknown>>;
    // 只认选项表里存在的值，避免旧版本 / 手改出来的脏数据
    for (const row of ROWS) {
      const v = saved[row.key];
      if (row.options.some(o => o.value === v)) {
        (out[row.key] as SettingValue) = v as SettingValue;
      }
    }
  } catch {
    /* 隐私模式下 localStorage 会抛异常，用默认值就好 */
  }
  return out;
}

export function saveSettings(s: VrSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 存不下就算了，本次会话内依然生效 */
  }
}

/* ---------- 画布布局（像素） ---------- */
const W       = 1280;
const PAD     = 44;
const HEADER  = 108;
const ROW_H   = 96;
/** 状态条：字大、背景深，头显里才看得清（之前 22px 的小字完全没法读） */
const STATUS_H = 88;
const FOOTER_H = 100;
const H       = HEADER + ROWS.length * ROW_H + STATUS_H + FOOTER_H;
const CHIP_X  = 520;
const CHIP_W  = W - PAD - CHIP_X;
const RESET_W = 260;
const RESET_H = 62;
const RESET_X = W - PAD - RESET_W;
const STATUS_Y = HEADER + ROWS.length * ROW_H;
const FOOTER_Y = STATUS_Y + STATUS_H;
const RESET_Y = FOOTER_Y + (FOOTER_H - RESET_H) / 2;

type Target = { row: number; opt: number } | 'reset' | null;

export interface SettingsHandle {
  group: THREE.Group;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** 把面板摆到头前下方 */
  placeInFrontOf(headPos: THREE.Vector3, headDir: THREE.Vector3): void;
  /** 射线悬停高亮；返回是否命中面板 */
  hover(raycaster: THREE.Raycaster): boolean;
  /** 射线都没指过来时清掉高亮 */
  clearHover(): void;
  /**
   * 扣扳机。命中选项就写入 settings 并返回它的 key；
   * 命中「恢复默认」返回 'reset'；没命中返回 null。
   */
  click(raycaster: THREE.Raycaster): keyof VrSettings | 'reset' | null;
  /** 面板底部的实时状态行（采样比、帧时这些） */
  setStatus(text: string): void;
  /** 外部改了 settings 后刷新显示 */
  invalidate(): void;
  update(dt: number): void;
  dispose(): void;
}

export interface SettingsOptions {
  settings: VrSettings;
  /** 面板宽度（米） */
  width:  number;
  /** 离头多远（米） */
  dist:   number;
  /** 相对眼高往下多少（米） */
  dropY:  number;
  /** 向上仰起的角度（弧度） */
  tilt:   number;
  /** 设备是否真的提供了原生合成层，不支持时把那一行标灰 */
  layersAvailable: boolean;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}

export function createSettingsPanel(opts: SettingsOptions): SettingsHandle {
  const { settings, layersAvailable } = opts;

  const group = new THREE.Group();
  group.rotation.order = 'YXZ';   // 先偏航再俯仰，否则倾斜会绕世界轴转歪
  group.visible = false;

  const canvas  = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx     = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const panelH = opts.width * (H / W);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(opts.width, panelH),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );
  group.add(mesh);

  let open   = false;
  let openT  = 0;
  let hovered: Target = null;
  let dirty  = true;
  let statusText = '';

  const rowEnabled = (row: SettingRow) => row.key !== 'useLayers' || layersAvailable;

  const draw = () => {
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(12,12,16,0.94)';
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 标题
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 46px system-ui, -apple-system, sans-serif';
    ctx.fillText('画质设置', PAD, 62);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '400 30px system-ui, -apple-system, sans-serif';
    ctx.fillText('指向选项扣扳机 · 再点「设置」按钮关闭', PAD + 260, 62);

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(PAD, HEADER - 18);
    ctx.lineTo(W - PAD, HEADER - 18);
    ctx.stroke();

    for (let r = 0; r < ROWS.length; r++) {
      const row = ROWS[r];
      const y   = HEADER + r * ROW_H;
      const on  = rowEnabled(row);

      // 标签 + 说明
      ctx.textAlign = 'left';
      ctx.fillStyle = on ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.3)';
      ctx.font = '500 40px system-ui, -apple-system, sans-serif';
      ctx.fillText(row.label, PAD, y + (row.hint ? 42 : 56));
      if (row.hint) {
        ctx.fillStyle = on ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.18)';
        ctx.font = '400 24px system-ui, -apple-system, sans-serif';
        ctx.fillText(row.hint, PAD, y + 74);
      }

      // 选项块
      const n  = row.options.length;
      const cw = CHIP_W / n;
      for (let i = 0; i < n; i++) {
        const o  = row.options[i];
        const cx = CHIP_X + i * cw;
        const cy = y + 16;
        const ch = ROW_H - 32;
        const active  = settings[row.key] === o.value;
        const isHover = on && hovered !== 'reset' && hovered?.row === r && hovered?.opt === i;

        ctx.fillStyle = !on
          ? 'rgba(255,255,255,0.04)'
          : active
            ? 'rgba(61,107,255,0.92)'
            : isHover
              ? 'rgba(255,255,255,0.18)'
              : 'rgba(255,255,255,0.07)';
        roundRect(ctx, cx + 5, cy, cw - 10, ch, 12);
        ctx.fill();

        if (isHover && !active) {
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.textAlign = 'center';
        ctx.fillStyle = !on
          ? 'rgba(255,255,255,0.25)'
          : active ? '#fff' : 'rgba(255,255,255,0.66)';
        ctx.font = `${active ? 600 : 400} 34px system-ui, -apple-system, sans-serif`;
        ctx.fillText(o.label, cx + cw / 2, cy + ch / 2 + 12);
      }
    }

    // 实时状态条：深底 + 大字，头显里要能直接读出来。
    // 菜单会挡住银幕下方的 HUD，所以诊断信息放在这里。
    roundRect(ctx, PAD - 16, STATUS_Y + 8, W - (PAD - 16) * 2, STATUS_H - 16, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    if (statusText) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(160,255,190,0.95)';
      ctx.font = '500 34px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillText(statusText, PAD + 10, STATUS_Y + STATUS_H / 2 + 12);
    }

    // 恢复默认
    const resetHover = hovered === 'reset';
    ctx.fillStyle = resetHover ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)';
    roundRect(ctx, RESET_X, RESET_Y, RESET_W, RESET_H, 12);
    ctx.fill();
    if (resetHover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '500 32px system-ui, -apple-system, sans-serif';
    ctx.fillText('恢复默认', RESET_X + RESET_W / 2, RESET_Y + RESET_H / 2 + 11);

    texture.needsUpdate = true;
  };

  /** 射线打在面板上的哪一项 */
  const targetAt = (raycaster: THREE.Raycaster): Target => {
    if (!group.visible) return null;
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit?.uv) return null;
    const x = hit.uv.x * W;
    const y = (1 - hit.uv.y) * H;

    if (x >= RESET_X && x <= RESET_X + RESET_W && y >= RESET_Y && y <= RESET_Y + RESET_H) {
      return 'reset';
    }
    if (y < HEADER || x < CHIP_X) return null;
    const r = Math.floor((y - HEADER) / ROW_H);
    if (r < 0 || r >= ROWS.length) return null;
    if (!rowEnabled(ROWS[r])) return null;
    const n = ROWS[r].options.length;
    const i = Math.floor((x - CHIP_X) / (CHIP_W / n));
    if (i < 0 || i >= n) return null;
    return { row: r, opt: i };
  };

  const sameTarget = (a: Target, b: Target) => {
    if (a === b) return true;
    if (!a || !b || a === 'reset' || b === 'reset') return false;
    return a.row === b.row && a.opt === b.opt;
  };

  return {
    group,
    isOpen: () => open,
    setOpen: (v: boolean) => {
      open = v;
      if (!v) hovered = null;
      dirty = true;
    },
    placeInFrontOf: (headPos, headDir) => {
      group.position.set(
        headPos.x + headDir.x * opts.dist,
        headPos.y + opts.dropY,
        headPos.z + headDir.z * opts.dist
      );
      // 面板正面朝 +Z，要让它回头看着观众
      group.rotation.y = Math.atan2(-headDir.x, -headDir.z);
      group.rotation.x = opts.tilt;
    },
    hover: (raycaster) => {
      const t = targetAt(raycaster);
      if (!sameTarget(t, hovered)) { hovered = t; dirty = true; }
      return t !== null;
    },
    clearHover: () => {
      if (hovered !== null) { hovered = null; dirty = true; }
    },
    click: (raycaster) => {
      const t = targetAt(raycaster);
      if (!t) return null;
      if (t === 'reset') {
        Object.assign(settings, DEFAULT_SETTINGS);
        dirty = true;
        return 'reset';
      }
      const row = ROWS[t.row];
      const val = row.options[t.opt].value;
      if (settings[row.key] === val) return null;   // 点的是当前值，不用折腾
      (settings[row.key] as SettingValue) = val;
      dirty = true;
      return row.key;
    },
    setStatus: (t: string) => {
      if (t !== statusText) { statusText = t; dirty = true; }
    },
    invalidate: () => { dirty = true; },
    update: (dt: number) => {
      openT += ((open ? 1 : 0) - openT) * Math.min(1, dt * 14);
      group.visible = openT > 0.01;
      if (!group.visible) return;
      group.scale.setScalar(0.96 + 0.04 * openT);
      (mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, openT * 1.4);
      if (dirty) { dirty = false; draw(); }
    },
    dispose: () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshBasicMaterial).dispose();
      texture.dispose();
    },
  };
}
