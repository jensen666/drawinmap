# 测试说明

本目录的测试**全部用 Node 直接运行**（不依赖浏览器、不依赖 npm 依赖）：
每个 `test/*.mjs` 自带断言、失败计数与非零退出码，可以单独 `node test/xxx.mjs` 跑。

## 一键跑全量

```bash
npm test            # 全量确定性测试（79 个；行数随新增用例变化，不写死）
npm run test:fast   # 日常：跳过慢测（engine-smoke / corpus-replay）
npm run test:list   # 列出将要执行的测试
npm test -- --only engine   # 只跑文件名含 "engine" 的测试
node tools/run-tests.mjs --check-only   # 全量 node --check 语法检查
```

`npm test` 退出码 0 = 全部通过。单个测试失败时，runner 会打印失败断言行。

## 行为基线与静态闸门（2026-11-09 二次精减阶段 0 基建）

| 工具 / 用例 | 作用 |
| --- | --- |
| `tools/diff-baseline.mjs` | 递归逐字段对比两份 JSON 基线（支持 `--ignore=` 白名单），等价重构的"零差异"判据；自测见 `test/diff-baseline.mjs` |
| `test/engine-characterization.mjs` + `test/fixtures/engine-characterization.json` | 5 个固定合成场景的引擎行为特征化 golden（T-B1b）；`--update` 重生成，默认逐字段严格对比 |
| `test/controller-golden.mjs` + `test/fixtures/controller-golden.json` | 10 场景 / 15 轮 controller 交付 golden（T-B2d，`test/lib/controller-harness.mjs` 装配） |
| `test/lib/fake-dom.mjs` | 轻量 fake DOM/假定时器（`innerHTML` 读写抛错，强制全 `textContent`）；`panel-toast` / `ui-render` 复用 |
| `tools/check-module-graph.mjs` | 模块图闸门：0 循环、0 生产不可达、浏览器可达文件 0 个 `node:` import、0 断链 import（纳入 `npm run check`） |
| `tools/check-tools-cdp.mjs` | 禁止 tools 驱动再内嵌 CDP 基建（唯一实现 `tools/lib/cdp-driver.mjs`，T-D4） |
| `tools/check-css-dupes.mjs` | `style.css` 重复声明体组数/块数阈值闸门（T-B3c） |

## 分层：哪些测试需要什么

| 类别 | 文件特征 | 需要 | 耗时 |
| --- | --- | --- | --- |
| **确定性测试**（默认全跑） | `test/*.mjs` 中自带 `process.exit` 的 | 仅 Node | 多数 < 2s |
| **慢测** | `engine-smoke.mjs`、`corpus-replay.mjs` | 仅 Node + 真实路网数据 | 各 2~3 分钟 |
| **用例库**（不单独运行） | 导出 `CASES`、无 `process.exit`：如 `e2e-*-cases.mjs`、`e2e-case-lib.mjs` | — | 由 `tools/e2e-*.mjs` 驱动 |
| **真实浏览器 E2E** | `tools/e2e-*.mjs` + `test/e2e-*-cases.mjs` | Node + **真实浏览器（Edge/Chrome，CDP 驱动）** + **真实 LLM API** + 真实广州路网 + 外网 | 每例 30~90s |

> **真实 E2E 不进 CI**：真实 LLM 的成本与耗时不可控。它们是**合并前必跑**清单，
> 由 `docs/archive/2026-11/方案设计/2026-11-09-代码库清理方案.md` §5.6.4 给出"改动面 → 必跑套件"矩阵。

## 交付前必跑：E2E-S 冒烟集（6 例）

清理方案 §5.6.4.1 定的规矩：**每批改动后必跑 E2E-S，6/6 通过才算冒烟通过**。
一条命令跑完（内部串起方案里的 3 条命令，统一判定 6/6）：

```bash
node web/server.mjs 5173     # 另开窗口；改过 server.mjs 必须重启
npm run test:e2e:smoke       # = node tools/run-e2e-smoke.mjs
```

| 例 | 覆盖 | 驱动 |
| --- | --- | --- |
| `A1` | 内置心形 + 地点别名 + 显式尺寸 | `tools/e2e-real-llm-30.mjs` |
| `B1` | 本地参考图命中（出候选卡则点选后规划） | 同上 |
| `F1` | 推荐链路（入口二） | 同上 |
| `G2` | 进行中停止 | 同上 |
| `TS01` | 三路取齐 / 候选卡 | `tools/e2e-three-sources-suite.mjs` |
| `S01` | 多比例尺卡片 | `tools/e2e-real-llm-30.mjs` + `test/e2e-real-llm-scale-cases.mjs` |

**已知失败与回归要分开看**：用例定义里写了 `knownFail: '原因'` 的用例，报告里单列为
"已知失败"，**不计入回归失败**（`tools/e2e-real-llm-30.mjs` 汇总时会打印）；反过来，
如果标了 `knownFail` 的用例这次通过了，会打印"已修复"，提示把标记去掉。

## 专用验收驱动

| 驱动 | 覆盖 | 产物 |
| --- | --- | --- |
| `npm run test:e2e:llm-config`（`tools/e2e-llm-config.mjs`） | LLM 配置功能 13 例（E2E-01～E2E-13，真实浏览器 + 真实 LLM：设置界面/来源与优先级/保存即时生效/刷新持久化/恢复默认/测试连接成功与失败分类/未配置/配置损坏/生成中保存/窄屏） | `docs/测试报告/2026-11-09-LLM配置功能验收/`（截图与结果 JSON 为本机过程产物不入库，报告正文入库） |

## 前置数据

部分测试直接读被 `.gitignore` 忽略的大文件。缺失时 `tools/run-tests.mjs`
会**显式 skip 并打印修复提示**（不再 ENOENT 崩溃）。单独 `node test/xxx.mjs` 时，
读路网的入口会打印同一条生成说明并以退出码 2 结束（`test/lib/require-data.mjs`）：

| 数据 | 谁需要 | 怎么来 |
| --- | --- | --- |
| `mapdata/guangzhou-roads.json`（6.7MB） | 10 个测试（`engine-smoke`、`selection`、`agent-intent`、`place-context`、`double-gate`、`feature-arcs`、`fixed-candidates`、`human-fitting`、`offset-reason`、`controller-replies`）+ `corpus-replay` 间接 | `mapdata/tools/` 下的脚本从 PBF 生成，详见 [mapdata/README.md](../mapdata/README.md) |
| `web/data/guangzhou-roads.json`（6.7MB） | `joint-refine`；页面本身也按 `cities[].roads.dataUrl` 加载 | 从 `mapdata/guangzhou-roads.json` 复制一份 |
| `test/fixtures/trace-images/` | `tools/e2e-long-tail.mjs`（非确定性测试） | `node tools/make-trace-fixtures.mjs` 幂等生成；E2E 驱动检测缺失会自动生成 |
| `web/src/agent/agent-config.js` | 所有真实 LLM E2E | 按 [README](../README.md#智能体配置) 新建（**含密钥，不入库**） |

真实浏览器 E2E 还需要：

```bash
node web/server.mjs 5173        # 另开窗口启动（改过 server.mjs 必须重启）
```

浏览器自动探测 Edge/Chrome；探测不到时用 `--browser <可执行文件路径>` 指定。

## 目录

| 路径 | 内容 |
| --- | --- |
| `test/*.mjs` | 确定性测试与 E2E 用例库 |
| `test/fixtures/e2e-shapes/` | 断言依赖的 SVG 素材源（**必须入库**），`web/data/shapes/library/` 是它的生成物 |
| `test/fixtures/frozen-targets/` | 固定基准目标（必须入库） |
| `test/fixtures/unsupported/` | "必须拒绝"的负样本（必须入库） |
| `test/fixtures/corpus/` | 语料回放的固定语料与几何度量工具 |
| `test/fixtures/place-config.mjs` | 地点配置 fixture（代替真实配置做断言） |
| `test/fixtures/fixed-samples.mjs` | 固定样本 fixture |

## 提交纪律

测试代码与断言依赖的输入**必须入库**；测试运行产生的截图、结果 JSON、运行日志、
可重新生成的素材**不入库**（详见 使用说明）。
