# 不支持素材样本（真实反例）

- `trex-phylopic.svg`：PhyloPic 霸王龙剪影，CC BY 4.0，作者 Fred Wierum。
  源：https://www.phylopic.org/images/832a47bd-0cd4-4b0e-af7b-db9d7ff81867
  该文件由 potrace 生成，含 31 个 `<path>` / 112 个子路径，碎片化严重；当前第一阶段
  只支持单个闭合外轮廓，测试应断言它被明确拒绝（fragmented-paths），而不是静默取主环。

- `cat-openclipart.svg`：Openclipart 坐猫剪影，公有领域，作者 nehtaeh79。
  源：https://openclipart.org/detail/169097/sitting-cat-silhouette
  该文件含 3 个互不相连的独立部分（身体/尾部等），当前只支持单外轮廓，测试应断言
  它被拒绝（multi-part），而不是只取最大的一个环。
