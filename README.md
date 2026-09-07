# 摄影作品集 · 浏览器端智能功能说明

静态站点相册（Vite + React，数据在 `public/photos.json`）。图片托管在 Cloudinary，元数据由管理面板写回 GitHub。智能能力全部在浏览器里用 [Transformers.js](https://huggingface.co/docs/transformers.js) 跑开源 ONNX，**没有服务端推理**。

访客浏览时不下载任何模型：打标、向量、焦点都在后台算一次，结果写进 JSON。

```
npm install
npm run dev          # http://localhost:8000
npm run smoke        # 无头 Chrome 核对 MobileCLIP 打标（需本机 Chrome）
```

---

## 三件事分别做什么

| 功能 | 访客看到什么 | 谁在什么时候算 |
| --- | --- | --- |
| 主题筛选 + 相似推荐 | 画廊主题 chip、搜索框、灯箱底部「相似」 | Admin 点「标签与色调 / 语义索引」 |
| 自动标签与色调 | 标签、悬停叠色；文件名像 `DSC_1234` 时用标签当标题 | 同上；色调不走模型，从像素取主色 |
| 智能裁切与封面建议 | 卡片 / 封面 `object-position` 对上主体 | Admin 点「主体焦点 / 主体与封面分」 |

---

## 用了哪些模型

运行库：`@huggingface/transformers` ^4.2。设备优先 WebGPU，没有就 WASM。注意：浏览器里设备名是 `webgpu` / `wasm`，**不能写 `cpu`**（那是 Node 端的名字，会直接抛 `Unsupported device`）。见 `src/ml/runtime.ts`。

| 用途 | 仓库 | 体积（约） | 精度 | 为什么选它 |
| --- | --- | --- | --- | --- |
| 图像向量、零样本主题、封面分 | [Xenova/mobileclip_s2](https://huggingface.co/Xenova/mobileclip_s2)（Apple MobileCLIP S2） | 视觉塔 fp32 ≈ 143 MB；文本塔 WebGPU fp16 ≈ 127 MB / WASM q8 ≈ 64 MB | 视觉塔钉 fp32（卷积量化掉点明显）；文本塔可量化 | 视觉 / 文本 ONNX **分开导出**，打标只在 Admin 下。同量级零样本比 Chinese-CLIP 稳，实测花卉不会再被判成人像 |
| 主体框 → 裁切重心 | [Xenova/detr-resnet-50](https://huggingface.co/Xenova/detr-resnet-50) | 检测管线，fp16 / q8 | 只要框位置 | Transformers.js 4.x 没有 CLIPSeg；物体检测够用。人物框加权 |

**没有上的方案：**

- **Chinese-CLIP ViT-B/16**：只导出一张合并 ONNX，访客搜一个词也要拉整包；量化后「花 → 人像」。
- **SigLIP 2 base**：精度和中文都更好，但文本塔 uint8 约 283 MB，不适合每个访客下载。主题 chip 是固定词表，提示词用英文即可。
- **色调**：Canvas 主色映射到现有八档 tint，不另下模型（`src/ml/palette.ts`）。

MobileCLIP **只认英文**。界面标签仍是中文（人像 / 花卉 / …），提示词写成英文句子。访客输入框按标题、标签、地点、年份匹配，**不做中文语义检索**。

---

## 总体思路：算一次，读很多次

```
后台（Admin，下载模型）                         访客（零模型）
─────────────────────────                      ────────────────
embedImage  → embedding + embedModel           GallerySearch：chip / 本地字段
classifyThemes → tags                          Lightbox：cosine(embedding)
tintFromImage → tint
focusFromImage → focus                         PhotoCard / 封面：object-position
aestheticFromImage → aesthetic
        │
        ▼
  public/photos.json（提交到 GitHub Pages）
```

推理图一律走 Cloudinary 短边 384 的变换 URL，不改展示用的 `src`（`src/ml/imageSrc.ts` 的 `mlImageSrc`）。

向量写入时带 `embedModel: "mobileclip_s2"`。换模型后维度可能仍是 512，语义空间已经不同。`toPhoto`（`src/usePhotos.ts`）遇到标记对不上的向量直接丢掉，相似推荐和「待索引」计数才会一致。

---

## `photos.json` 多出来的字段

定义在 `src/data.ts`：

| 字段 | 含义 |
| --- | --- |
| `tags` | 中文主题，最多 3 个 |
| `embedding` | L2 归一化后的图像向量（约 512 维，四位小数） |
| `embedModel` | 产出该向量的模型 id |
| `focus` | `{ x, y }`，0–1，给 `object-position` |
| `aesthetic` | 0–1，「好照片」一侧的 softmax 概率 |

---

## 代码怎么串

```
src/ml/runtime.ts     设备 + dtype
src/ml/imageSrc.ts    缩略图 URL、余弦、压缩向量
src/ml/clip.ts        MobileCLIP 双塔：embedImage / scoreGroups
src/ml/tagging.ts     中文标签词表 + 英文提示词 + pickTags
src/ml/search.ts      访客侧：chip、本地搜索、similarTo
src/ml/focus.ts       DETR 焦点 + CLIP 封面分
src/ml/palette.ts     主色 → tint

src/QueueSmart.tsx    队列 / 已发布：标签 + 向量
src/FocusSmart.tsx    队列 / 已发布：焦点 + 封面分
src/AdminPanel.tsx    把上面字段写进 GitHub 上的 photos.json
src/GallerySearch.tsx 同步筛选，不加载模型
src/Lightbox.tsx      similarTo
src/PhotoCard.tsx     focus → object-position
src/App.tsx           封面同样用 focus；GallerySearch 过滤可见列表
```

Transformers.js 用动态 `import()`，Vite 里 `optimizeDeps.exclude` 了该包（`vite.config.ts`）。

---

## 功能 1：主题 chip、搜索、相似

**后台**（`QueueSmart` / `PublishedSmart`）

1. `embedImage` 只加载视觉塔，得到单位向量。
2. `classifyThemes` 加载文本塔，把每个主题的多条英文提示词向量取平均当原型，再和图像向量算余弦，一组里做 softmax（logit 缩放 100）。
3. `pickTags`：最高类概率 &lt; 0.3 就不打标；其余要 ≥ 0.15 且不低于第一名的一半，最多 3 个。
4. 写入 `embedding` + `embedModel` + `tags`。

**访客**（`src/ml/search.ts`）

- chip：只展示图库里真正出现过的主题（`availableThemes`），按 `tags` 过滤。
- 输入框：标题权重 1、标签 0.8、地点/年份 0.6，子串命中后排序；未命中的丢掉。
- 灯箱：当前图与其它图的 `embedding` 余弦，取前 5 张。

文本塔 **padding 必须是 `'max_length'`**（长度 77）。`padding: true` 只会补到本批最长，ONNX 形状对不上。输出必须自己做 L2，模型不会归一化。

主题提示词在 `src/ml/tagging.ts` 的 `THEME_PROMPTS`。改提示词一般不用重算向量，但标签会变，可在管理页对已有索引再点一次「语义索引」整体重算。

---

## 功能 2：自动标题与色调

和功能 1 同一条分析流水线：

- 标题像 `DSC` / `IMG` / `微信图片` 等，且打出了标签 → 标题改成第一个标签（`isGenericTitle` / `titleFromTags`）。
- 标签没把握时不改标题。
- `tintFromImage` 把图缩到 32×32，按色相落入 `src/tints.ts` 的八档。

---

## 功能 3：主体焦点与封面分

**焦点**（`focusFromImage`）

1. `pipeline('object-detection', 'Xenova/detr-resnet-50')`，阈值 0.55。
2. `importance = score × 人物加权(1.45) × (0.65 + √面积)`。
3. 取最高框的中心，归一化到 0–1。没有检测结果则 `(0.5, 0.5)`。
4. 坐标可能是 0–1 或 0–100，用最大值是否 &gt; 1.01 判断（`boxScale`）。

**封面分**（`aestheticFromImage`）

不另下美学模型。同一套 MobileCLIP 对「精美专业照片」vs「模糊废片」两组英文提示词打分，取 good 的概率。`suggestCoverId` 取分最高的一张，管理页可一键设为封面。

---

## 后台怎么用

1. 打开站点，进管理面板。
2. **上传队列**：先「标签与色调」，再「主体焦点」，再发布。
3. **已发布**：点「语义索引」补向量和标签（没有缺失时会问是否用当前模型整库重算）；点「主体与封面分」补 `focus` / `aesthetic`。
4. 等 GitHub 提交并 Pages 刷新。chip 和相似推荐依赖已写入的 `tags` / `embedding`。

权重缓存在浏览器里，同一台机器第二次不用重下。

---

## 核对打标（冒烟）

真实走 `src/ml/clip.ts` 和 `src/ml/tagging.ts`，不是另一套脚本：

```bash
npm run smoke                      # 默认：郁金香、虞美人等有中文名的花
npm run smoke -- sample=14         # 隔几张抽 14 张其它图
npm run smoke -- titles=郁金香,人像
```

入口：`smoke.html` → `src/smoke.ts`，由 `scripts/smoke-run.mjs` 起 Vite + 无头 Chrome，把页面结果打到终端。`vite build` 不会把 `smoke.html` 打进站点。

换过提示词之后，用默认那批花看「花卉」是否仍是第一名，再用 `sample=` 看会不会所有图都变成同一个标签。

---

## 已知边界

- 访客不能用任意中文做语义检索（「雾」「红墙」这类要靠标题或标签里真有这些字）。
- DETR 认的是 COCO 物体；纯纹理、空旷风景可能没有框，裁切会落在画面中心。
- 封面分是「好 / 差」二选一的相对概率，不是摄影比赛评分。
- 静态托管：模型从 Hugging Face 拉。首次分析需要能访问 `huggingface.co`。
