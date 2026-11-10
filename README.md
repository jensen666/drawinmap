# DrawInMap

在真实可步行路网上规划出能走出来的图形路线：一句话或一张参考图，变成一条贴着道路的图形。

**当前阶段：Web 原型**。用 OSM 技术栈展示地图，并接入 LLM 智能体（自然语言 / 图片 → 图形路线规划），作为后续路线规划能力的地基。

> 本目录是 GitHub 发布副本。主开发仓库在 Gitee，GitHub 侧只做同步发布。

## 它做什么

- **自然语言画图**：输入「在广州塔附近画一个 800 米的五角星」这类需求，LLM 解析成结构化意图（图形 / 地点 / 尺寸），地点按配置解析为坐标，引擎在路网上规划出一条贴合的闭合路线。
- **参考图与自定义图形**：上传白底线稿 / 剪影，浏览器本地抽出单条外轮廓作为目标形状（不交给视觉模型），再结合文字里的地点需求规划；也支持参考素材库多候选与在线检索。
- **条件推荐**：只给条件不给图形（"我只有一小时，能画什么？"），系统对内置图形逐一实测，只推荐质量达标的那几个。
- **贴路而非硬画**：目标轮廓先验收、后规划；不达标不绘制，明说原因（临水 / 无路区 / 超出路网范围等），绝不给"四不像"的绿线。
- **多比例尺候选**：一次规划实测出的各比例尺档并排成卡片，点选即时切换，不重新请求模型。
- **可追溯**：每轮对话一个 trace，记录 LLM 请求 / 响应 / 推理内容、地点解析、候选搜索与最终交付指标，回复下方点 traceId 即可复制。
- **历史对话回看**：对话与图形快照存本机，刷新不丢，可逐图翻看。
- **全国城市按需获取**：默认广州使用既有路网；其它城市在「城市」面板选好后由服务器按 Overpass API 真实下载，不预置全国数据。

## 快速开始

浏览器对 `file://` 下的 ES Modules 有 CORS 限制，不能直接双击 HTML，需要一个本地静态服务器。**无需 `npm install`**（原生 ES Modules，零构建）。

```bash
node web/server.mjs 5173
```

打开 <http://127.0.0.1:5173>。服务器只监听本机 `127.0.0.1`，并自带 `Cache-Control: no-store`（改完 JS 刷新即生效）。

## 智能体配置

对话功能需要一个 OpenAI 兼容的 `chat/completions` 接口。推荐在页面右下角「智能体」→「设置」里填写，配置保存在本机浏览器，下一轮对话立即生效。

也可以新建 `web/src/agent/agent-config.js`（已在 `.gitignore` 中，**密钥不要入库**）作为默认与兜底：

```js
export const AGENT_LLM = {
  baseUrl: 'https://api.example.com/v1',  // 不含 /chat/completions
  apiKey: '<YOUR_API_KEY>',
  model: '<YOUR_MODEL_NAME>',
  timeoutMs: 180000,
  maxTokens: 32000,
};
```

页面配置优先于该文件。未配置时地图与路网仍可用，只有对话会提示去配置。

## 路网数据

路网是 OpenStreetMap 派生数据，由于体积与许可原因**不入库**：`mapdata/guangzhou-roads.json` 与页面副本 `web/data/guangzhou-roads.json` 需要本地生成。缺这两份文件时，页面没有广州路网，依赖路网的测试会打印生成步骤并以退出码 2 结束（`npm test` 会跳过这些用例，而不是报 ENOENT）。

生成步骤与校验见 [mapdata/README.md](mapdata/README.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 地图库 | Leaflet 1.9.4（运行时文件在 `web/vendor/`，不依赖 CDN） |
| 底图 | OpenStreetMap 瓦片 |
| 路网 | OpenStreetMap 广东省 extract（本地裁剪） |
| 图形规划 | 原生 JS 引擎（`web/src/engine/`）：图形放置 → 吸附可步行路网 → 走廊引导 A* 串联 → 指标评估 |
| 智能体 | OpenAI 兼容接口，配置可在页面内完成 |
| 构建 | 无 |

## 目录结构

```
├── web/          # Web 原型（原生 HTML/CSS/ES Modules + 本地 Leaflet，零构建）
│   ├── src/      # main / map / engine / agent / session / city / reference / log
│   ├── server/   # Node-only 服务端模块（在线检索、城市路网获取）
│   ├── config/   # 地点配置与全国城市目录
│   └── data/     # 页面可访问的路网副本与形状素材库
├── mapdata/      # 离线路网数据与下载 / 解析工具
├── tools/        # 验收工具与真实浏览器（CDP）E2E 驱动
├── test/         # 测试（Node 直接运行）
```

城市、地标、别名与匹配策略全部来自外部配置 `web/config/place-gazetteer.json`，代码内不写死任何城市或地名。

## 测试

```bash
npm test          # 全部用例
npm run test:fast # 快速子集
npm run check     # 文档链接、模块依赖、文件大小等静态检查
```

真实浏览器 + 真实 LLM 的验收不在 `npm test` 里，需要自行配置端点与密钥后单独运行。详见 [test/README.md](test/README.md)。

## 许可

根目录 [LICENSE](LICENSE) 是 MIT，只覆盖项目自有的代码与文档。

以下三项不在这份 MIT 里：

- **路网数据**（含按需下载的城市路网）是 ODbL 1.0。分发时需署名 © OpenStreetMap contributors。
- **形状素材**：`web/data/shapes/` 与 `test/fixtures/e2e-shapes/` 的素材不重新许可，逐条保持原许可，署名表见 [web/data/shapes/ATTRIBUTION.md](web/data/shapes/ATTRIBUTION.md)。
- **名称** "DrawInMap" 不随这份许可授予。

第三方组件、数据与署名格式见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
