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

## 3D 展厅（顶部 Hall）

顶部导航第二项 **Hall** 进一个可以走进去的展厅：两侧墙上按策展顺序挂满作品，操纵一个小人走过去看。形态参考 [thevertmenthe.dault-lafon.fr](https://thevertmenthe.dault-lafon.fr)，照片直接取 `photos.json` 里的 Cloudinary 地址。

展厅几何（墙、地、天花、画框）全是代码生成的，外部资源只有 `public/hall/` 下的三个，都取自上面那个参考站：

| 文件 | 用途 |
| --- | --- |
| `personnage.glb` | 角色，带骨骼和 `walk` / `wait` / `coucou` 三段动画，2.2 MB |
| `footprintL.png` `footprintR.png` | 左右脚印图章 |

> 这三个是从参考站直接取的，只用于本地开发验证。真要公开发布得先拿到授权，或者换成自己的资产。

角色载入是容错的：glb 取不到就退回程序化的火柴人，展厅照样能走，不会卡在加载条上。glb 的尺寸不是米，载入后按包围盒统一缩放到 1.72m 身高、脚底对齐 y=0，所以换模型不用改代码里的数。脚印图是白底黑印的 RGB、alpha 整张 255，直接当 `map` 会在地上糊一块白方片，`footprintTexture()` 会把亮度取反成 alpha 并裁到墨迹外接框。

开场背后那面墙是前言墙，刻着三句摄影师的话（卡蒂埃-布列松 / 亚当斯 / 兰格）—— 拖动画面转个身才看得到。

| 操作 | 效果 |
| --- | --- |
| `W` `A` `S` `D` / 方向键 | 相对镜头前后左右 |
| `Shift` | 快走 |
| 拖动画面 | 转视角 |
| 走到画前按 `Enter` | 开灯箱看原图（缩放、拍摄信息、相似推荐都在那边） |
| 直接点某幅画 | 同上，不用走过去 |

手机上左下角有虚拟摇杆，操作提示换成摇杆。

### 为什么不是一次把图都贴上去

124 张图全量常驻显存要上百 MB，加载也要好几十秒。所以 `hall.ts` 按距离分三档流式加载：9m 内取 1280 宽、26m 内取 448 宽、34m 外直接 `dispose`，同时最多 4 个请求在飞、近的先排。进度条统计开场最近的 8 张加上角色 glb，走进去之后是边走边补。

### 几个改起来要小心的地方

- **画框是三层贴着摆的**：外框盒整个埋在墙里（局部 `z ≤ 0`），卡纸凸出 12mm，画心再往前 2mm。三段 z 区间必须严格不相交，一旦画心陷进卡纸盒体里，看到的就只剩一块白卡纸。
- **「在看哪张画」不能用直线距离**。看画是站在几米开外正对着看的，直线距离区分不了「正对着这张」和「贴着墙路过隔壁那张」。所以拆成沿走廊的错开量（`focus.along`，要小）和离墙距离（`focus.out`，可以宽松）分别卡。
- **灯箱盖上来时必须 `setPaused(true)`**（`App` 按 `lightboxPhoto` 传 `paused`）。不暂停的话方向键会同时翻灯箱的页和走展厅里的人，而且看照片时白白渲染一整个场景。
- **相机撞墙是缩短弹簧臂，不是限制人的走位**（`armLength`）。想要的机位在墙外就把臂按射线求交缩短；臂被压到 2.4m 以内时 `setBodyFade` 把角色整体淡出，不然满屏只剩后脑勺。别图省事反过来做 —— 一旦为了给相机腾地方去卡住人的位置，人就走不到入口墙跟前读前言了，而且那个限制还是无条件的：其实只有镜头夹在人和墙中间时才挤得着。
- **自动观赏机位要沿走廊错开 `viewing.sideOffset`**。画心在 1.62m，跟角色头顶差不多高，相机严格站在人正后方的话脑袋刚好糊在画上。
- **前言墙的字号是按远距离定的，不是按看网页定的**。刚进展厅转身时离那面墙有 11.7m，字高得做到 0.3m 才读得清 —— 也正因为这么大，只放得下三句，而且整块要抬到 1.7m 以上，不然角色站中间会挡住下面的字。改文案时先数字数：最长一句超过 16 个汉字就会顶到面片边缘。
- three 走动态 `import()`，构建后是独立 chunk（约 59 KB + 共用的 three），不点这个 tab 就不会下。

---

## 3D 视差（深度图）

照片详情里点 **3D** 按钮进入视差灯箱：鼠标移动时相机绕画面中心小幅公转，近处走得快、远处走得慢 —— 是真实的视角变换，不是叠几层做假位移。右上角可切回 2D，「返回普通浏览」回到原来的灯箱（缩放 / 拍摄信息都在那边）。

深度图离线用 YOLO26-depth 预生成，浏览器只负责渲染：

### 装一次环境

脚本要 torch，别装进系统 Python，用独立虚拟环境：

```bash
python3 -m venv .venv                 # 已在 .gitignore 里
.venv/bin/pip install ultralytics     # 会自动带上 torch / numpy / pillow
.venv/bin/pip install "numpy<2"       # 见下面「坑」
```

装完就是这几样：`ultralytics 8.4.153` + `torch 2.2.2(CPU)` + `numpy 1.x` + `pillow`。

> **坑**：pip 给 Python 3.12 解析到的 `torch 2.2.2` 是按 numpy 1.x 编的，
> 配 numpy 2.x 会在推理时报 `Numpy is not available`（不是深度图的问题）。
> 所以要么 `pip install "numpy<2"`，要么先装个新 torch（`pip install -U torch`）再装 ultralytics。

装 `opencv-contrib-python` 是可选的：有了会多一步引导滤波，深度边缘更贴合物体；没有就退化成高斯模糊，也能跑。

### 跑

```bash
.venv/bin/python scripts/depth_export.py --dry-run          # 先看会动哪些
.venv/bin/python scripts/depth_export.py --limit 3          # 先跑 3 张看效果
.venv/bin/python scripts/depth_export.py                    # 全量补生成（已有 depth 的跳过）
.venv/bin/python scripts/depth_export.py --ids <id> --force # 重算某张
.venv/bin/python scripts/depth_export.py --model yolo26s-depth.pt --force  # 换更准的模型重算
.venv/bin/python scripts/depth_export.py --device mps       # Mac 上试 GPU（跑不动就去掉）
```

- 权重首次会从 GitHub releases 下到**当前目录**（`yolo26n-depth.pt`，13MB）。
  想保持仓库干净，先下好再用 `--model /绝对路径/yolo26n-depth.pt` 指定。
- CPU 上大约 4 秒一张，124 张约 7–8 分钟。

- 产出 `public/depth/<id>.png`（8bit 灰度「归一化视差」，0=最远 255=最近，长边 640），
  并把 `depth` / `depthRange` 两个字段写回 `public/photos.json`（原文件备份成 `photos.json.bak`）。
- `--fake` 不跑模型，直接写一张径向渐变假深度图。装 torch 之前想先看前端链路通不通，用这个：
  `python scripts/depth_export.py --fake --limit 2`。跑真模型时记得加 `--force` 覆盖掉。
- 没装 opencv-contrib 也能跑，只是少一步引导滤波，深度边缘没那么贴合物体。
- 上传时自动生成、以及浏览器端实时推理都还没做：实时推理单帧几百毫秒，跟不上鼠标。

前端：`src/depth/parallax.ts`（three.js 细分网格 + 顶点位移）、`src/DepthLightbox.tsx`（专用灯箱）。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 最大 yaw / pitch | 7° / 4° | 超过 10° 前景就开始拉伸 |
| 平滑时间常数 | 90ms | 太小发抖，太大拖沓 |
| 视差强度 | 0.12（灯箱里可调） | 近处相对画幅高度的位移量，0.05 微妙、0.25 夸张 |
| 网格细分 | 176（长边） | 再高收益递减 |

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
