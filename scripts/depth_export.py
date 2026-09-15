#!/usr/bin/env python3
"""
为 public/photos.json 里的照片生成深度图（YOLO26-depth）。

产出两样东西：
  1. public/depth/<id>.png —— 8bit 灰度「归一化视差」图，0=最远，255=最近
  2. photos.json 里每条记录多两个字段
       "depth":      "depth/<id>.png"
       "depthRange": [near, far]        # 单位米，前端还原视差用

为什么存视差（1/z）而不是米：
  视差 = b*f/z，和「像素位移」成正比，8bit 量化后精度天然偏向近处（近处
  细节多、深度分辨率要求高）；直接存米会让远处吃掉一半以上的码字。

用法：
    pip install ultralytics opencv-contrib-python numpy

    # 全量补生成（已有 depth 的会跳过）
    python scripts/depth_export.py

    # 只跑某几张 / 强制重算 / 换模型
    python scripts/depth_export.py --ids 1788880712900-5es4q
    python scripts/depth_export.py --force
    python scripts/depth_export.py --model yolo26x-depth.pt --imgsz 768

    # 先看会动哪些，不写盘
    python scripts/depth_export.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# cv2 只用来做引导滤波（opencv-contrib）。没装也能跑，只是深度边缘没那么贴合物体
try:
    import cv2
    from cv2.ximgproc import guidedFilter
except ImportError:
    cv2 = None
    guidedFilter = None

ROOT = Path(__file__).resolve().parent.parent
PHOTOS_JSON = ROOT / "public" / "photos.json"
DEPTH_DIR = ROOT / "public" / "depth"

# 深度图长边：网格位移只要低频信息，512~640 足够，再大只是浪费流量
LONG_SIDE = 640
# 视差分位裁剪：掐掉极近（可能糊掉的前景）和天空这类极远的离群值
LO_PCT, HI_PCT = 2.0, 98.0

def fetch_image(url: str, timeout: int = 30) -> np.ndarray:
    """下一张原图，返回 RGB uint8。Cloudinary 的 f_auto 会给 webp/avif，交给 Pillow 解。"""
    import io

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)


def to_u8_disparity(depth: np.ndarray, rgb: np.ndarray) -> tuple[np.ndarray, float, float]:
    """米制深度 -> 8bit 归一化视差图，返回 (u8, near, far)。"""
    z = np.clip(np.nan_to_num(depth, nan=1e-3, posinf=1e-3, neginf=1e-3), 1e-3, None)
    inv = 1.0 / z  # 视差，越大越近

    lo, hi = np.percentile(inv, [LO_PCT, HI_PCT])
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-9:
        # 整张图深度都差不多（纯天空、微距平场），视差全 0，前端自动退化成平面
        return np.zeros(inv.shape, dtype=np.uint8), 1.0, 1.0

    n = np.clip((inv - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)

    # 引导滤波：让深度边缘贴着照片的物体边缘，平坦区抹平。
    # 少了这一步，前景会在背景上糊出一圈「光晕」。
    if guidedFilter is not None:
        n = guidedFilter(rgb, n, radius=8, eps=1e-3)
    elif cv2 is not None:
        n = cv2.bilateralFilter(n, d=7, sigmaColor=0.08, sigmaSpace=7.0)
    else:
        # 没有 opencv：轻度高斯模糊，边缘会软一点，但不会出错
        n = np.asarray(
            Image.fromarray((n * 255).astype(np.uint8), mode="L").filter(ImageFilter.GaussianBlur(1.6)),
            dtype=np.float32,
        ) / 255.0

    n = np.clip(n, 0.0, 1.0)
    u8 = (n * 255.0 + 0.5).astype(np.uint8)

    near, far = float(1.0 / hi), float(1.0 / lo)
    return u8, near, far


def resize_keep(u8: np.ndarray, long_side: int = LONG_SIDE) -> np.ndarray:
    h, w = u8.shape[:2]
    s = min(1.0, long_side / max(h, w))
    if s >= 1.0:
        return u8
    im = Image.fromarray(u8, mode="L").resize(
        (max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS
    )
    return np.asarray(im, dtype=np.uint8)


def resize_depth(depth: np.ndarray, w: int, h: int) -> np.ndarray:
    """深度图按原图尺寸重采样。模式 F 是 float32，PIL 直接支持。"""
    return np.asarray(
        Image.fromarray(depth, mode="F").resize((w, h), Image.BILINEAR), dtype=np.float32
    )


def save_png(u8: np.ndarray, path: Path) -> None:
    Image.fromarray(u8, mode="L").save(path, optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo26n-depth.pt",
                    help="ultralytics 深度权重，n/s/m/l/x，越大越准越慢")
    ap.add_argument("--imgsz", type=int, default=768,
                    help="推理分辨率，官方权重按 768 训练，改小会掉精度")
    ap.add_argument("--device", default="",
                    help="推理设备，交给 ultralytics：留空自动选，Mac 上可试 mps，"
                         "NVIDIA 显卡可试 0。跑不动就删掉这个参数回 CPU")
    ap.add_argument("--ids", default="", help="只处理这些 id，逗号分隔")
    ap.add_argument("--limit", type=int, default=0, help="最多处理几张（调试用）")
    ap.add_argument("--force", action="store_true", help="已有深度图也重算")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写盘")
    ap.add_argument("--fake", action="store_true",
                    help="不跑模型，写一张假的径向渐变深度图。用来在装 ultralytics "
                         "（torch 那一大坨）之前先把前端链路跑通")
    ap.add_argument("--json", default=str(PHOTOS_JSON))
    ap.add_argument("--out", default=str(DEPTH_DIR))
    args = ap.parse_args()

    json_path = Path(args.json)
    out_dir = Path(args.out)
    if not json_path.exists():
        print(f"找不到 {json_path}", file=sys.stderr)
        return 1

    photos = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(photos, list):
        print("photos.json 不是数组", file=sys.stderr)
        return 1

    only = {s.strip() for s in args.ids.split(",") if s.strip()}
    todo = []
    for p in photos:
        if only and p.get("id") not in only:
            continue
        if p.get("depth") and not args.force:
            continue
        todo.append(p)
    if args.limit:
        todo = todo[: args.limit]

    print(f"共 {len(photos)} 张，待生成 {len(todo)} 张"
          + ("（--force）" if args.force else ""))
    if not todo:
        print("没有需要生成的，加 --force 可重算")
        return 0
    if args.dry_run:
        for p in todo:
            print(f"  would: {p.get('id')}  {p.get('title','')}")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)

    model = None
    if not args.fake:
        from ultralytics import YOLO  # 放在这里，--dry-run / --fake 不用等它 import

        model = YOLO(args.model)
        print(f"模型已加载：{args.model}（imgsz={args.imgsz}）")
    else:
        print("--fake：不跑模型，写径向渐变假深度图")

    if not args.dry_run:
        backup = json_path.with_suffix(".json.bak")
        shutil.copy2(json_path, backup)

    ok = fail = 0
    for i, p in enumerate(todo, 1):
        pid, src, title = p.get("id"), p.get("src"), p.get("title", "")
        if not pid or not src:
            print(f"[{i}/{len(todo)}] 跳过：缺 id 或 src")
            fail += 1
            continue
        print(f"[{i}/{len(todo)}] {title or pid}")
        try:
            if args.fake:
                # 中心最近、四角最远。够用来确认「前端确实在按深度位移」
                w = int((p.get("exif") or {}).get("width")  or 1600)
                h = int((p.get("exif") or {}).get("height") or 1067)
                yy, xx = np.mgrid[0:h, 0:w]
                nx = (xx / max(w - 1, 1) - 0.5) * 2
                ny = (yy / max(h - 1, 1) - 0.5) * 2
                r  = np.sqrt(nx ** 2 + ny ** 2) / np.sqrt(2)
                u8, near, far = (np.clip(1 - r, 0, 1) * 255).astype(np.uint8), 1.0, 10.0
            else:
                rgb = fetch_image(src)
                # 传数组而不是 URL：传 URL 时 ultralytics 会把图下到当前目录，
                # 跑一批就在仓库根堆一堆 jpg。它内部按 cv2 的 BGR 约定走，这里换一下通道。
                res = model(
                    rgb[..., ::-1], imgsz=args.imgsz, verbose=False,
                    **({"device": args.device} if args.device else {}),
                )
                depth = res[0].depth.data.cpu().numpy().astype(np.float32)
                # 模型输出对齐输入，这里再对齐回原图尺寸
                depth = resize_depth(depth, rgb.shape[1], rgb.shape[0])
                u8, near, far = to_u8_disparity(depth, rgb)

            u8 = resize_keep(u8)

            out_file = out_dir / f"{pid}.png"
            save_png(u8, out_file)

            p["depth"] = f"depth/{pid}.png"
            p["depthRange"] = [round(near, 4), round(far, 4)]
            ok += 1
            print(f"    -> {out_file.relative_to(ROOT)}  {u8.shape[1]}x{u8.shape[0]}  "
                  f"near={near:.2f}m far={far:.2f}m")
        except Exception as e:  # 单张失败不能把整批搞挂
            fail += 1
            print(f"    失败：{e}", file=sys.stderr)

    json_path.write_text(
        json.dumps(photos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\n完成：成功 {ok}，失败 {fail}")
    print(f"已写回 {json_path.relative_to(ROOT)}（原文件备份在 photos.json.bak）")
    print(f"深度图目录：{out_dir.relative_to(ROOT)}")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
