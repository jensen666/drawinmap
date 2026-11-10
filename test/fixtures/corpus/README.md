# 分层通用语料（阶段 0 冻结语料）

本目录是「图形路线视觉效果通用优化方案」§10 的语料定义，配合 `test/corpus-replay.mjs`
做基线回放。语料只按**几何属性**与**路网属性**分层，不含任何图形名称 / 对象类别 / 地点语义；
生产逻辑不读取样本身份。

## 文件

| 文件 | 作用 |
| --- | --- |
| `random.mjs` | 确定性伪随机（FNV-1a 哈希 + mulberry32）与 seed 派生 |
| `geometry-metrics.mjs` | 轮廓几何测量与分层判定（全部指标从点列算起） |
| `outline-generator.mjs` | 固定 seed 的程序化轮廓生成器（12 个原型）与采样档案 |
| `roadnet.mjs` | 真实路网分区裁剪 + 合成路网生成 + 路网属性测量 |
| `corpus.mjs` | 样本装配、几何/路网分层标签、校准集/留出集/最终留出集划分 |
| `baseline-phase0.json` | 阶段 0 基线回放报告（`node test/corpus-replay.mjs --set=all` 产出） |

## 几何分层维度（每维一个取值）

| 维度 | 取值 | 判定口径 |
| --- | --- | --- |
| `dominant` | straight / curved | 角点（转角 ≥ 20°）转角占全部转角的比例 ≥ 0.5 记 straight |
| `regularity` | regular / irregular | 径向轮廓的最佳 k 重旋转对称残差 ≤ 0.10 记 regular（在轻度平滑后的轮廓上量） |
| `notch` | none / shallow / deep | 顶点相对凸包的最大内陷 / 包围盒对角线：<0.05 none，<0.16 shallow，否则 deep |
| `gap` | none / narrow | 沿轮廓相距 18%~45% 而空间较近的边界点对最小距离 / 对角线 < 0.15 记 narrow |
| `protrusion` | none / slender | 极端点局部宽度（沿轮廓走 6% 周长后两点间距）→ 尖细度 ≥ 5 且极端半径/中位半径 ≥ 1.25 记 slender |
| `curvature` | normal / high | 窗口化曲率半径 20 分位 / 对角线 < 0.10 记 high |
| `perimeterSpan` | low / high | 周长 / 包围盒对角线 ≥ 3.6 记 high |
| `constraintDensity` | low / high | 约束点数 / 包围盒对角线 > 7 记 high |
| `parts` | single / multi | 轮廓是否由多个分离部件组成 |
| `noise` | clean / noisy | 非角点邻域里转向符号交替的小角顶点（0.2°~30°）占弧长比例 ≥ 0.06 记 noisy |
| `pointDensity` | sparse / medium / dense | 轮廓点数 ≤24 / ≤64 / 更多 |
| `localScale` | uniform / varied | 存在明显小于整体尺度的子结构（凹口 / 窄缝 / 细尖）记 varied |

## 路网分层维度

| 维度 | 取值 | 判定口径 |
| --- | --- | --- |
| `density` | sparse / medium / dense | 可步行路网 km / km²：<8 sparse，<18 medium，否则 dense |
| `orientation` | concentrated / diverse | 最大 10° 方向桶占比 ≥ 0.16 记 concentrated |
| `connectivity` | connected / fragmented | 主连通分量节点占比 ≥ 0.93 记 connected |
| `integrity` | intact / broken | 是否施加了屏障切路（断路环境） |

路网来源两种：真实路网（`mapdata/guangzhou-roads.json` 按矩形分区取样，保留完整道路以免
边界裁剪制造假碎片）与程序化合成路网（网格 / 放射状，交点共享节点因而真正连通，
支持分片与屏障切路）。密度、走向、连通性都在构建时从实际路网测得。

## 集合划分

- `calibration` / `holdout`：按几何与路网分层做分层抽样。每个样本属于 16 个分层，
  逐个按确定性哈希排序后，看它在各分层里"哪一侧当前更空"取多数票决定归属；
  全程不使用随机数，可复现。
- `final`：最终留出验收集，包含"未见过的轮廓形态"（`spiral-band`、`hook-band` 两个族）
  与"未见过的路网区域"（`R10`~`R13`、`S8`）——它们在 calibration/holdout 中完全不出现。

## 用法

```bash
node test/corpus-replay.mjs --set=calibration --limit=5   # 校准集前 5 个样本
node test/corpus-replay.mjs --set=holdout --limit=5       # 留出集前 5 个样本
node test/corpus-replay.mjs --set=all                     # 全量回放并刷新基线报告
```

回放脚本必须真实调用引擎的 `searchWithEscalation`（内部走 `planShapeRoute`），
不使用任何 mock 路线；语料由固定 seed 的程序化生成器产出，同一 seed 必然得到
同一份语料与同一份基线。
