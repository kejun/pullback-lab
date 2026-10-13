# 有界 Longbridge RAW 历史采集

显式日期窗口模式复用现有 `npm run probe`、`ProviderBarSample` 与私有 JSONL 检查点。不创建第二个采样服务，不调用交易/账户接口，不向数据库导入，不签发研究或实时资格。

## 采集

仅在用户已授权的应用 OpenAPI 环境、合法留存和账户额度内执行。使用应用原有秘密加载方式；不要把凭据放进命令参数或报告。不要与现有采样器并行执行：二者不共享账户请求额度账本。

```bash
umask 077
report_dir=$(mktemp -d "${TMPDIR:-/tmp}/pullback-history.XXXXXX")
npm run probe -- --symbols NVDA.US --history-from 2025-10-01 --history-through 2026-10-12 --observe-seconds 0 --output "$report_dir/checkpoints.jsonl"
```

日期仅演示明确起止方式，应换成实际审计窗口。两端均包含，最多1096个自然日，最多2个显式证券。每页最多90个自然日，末页包含 `through`；日线与该页历史交易日历分别串行请求。每个请求沿用现有间隔和截止时间，超时后不会继续堆积未决请求。默认非窗口 probe 行为保持不变。

窗口模式必须同时提供起止日期和新建输出文件。文件采用 create-only / 0600，每次成功采样后 fsync 检查点；不能覆盖已有报告。即使未写 `--summary`，终端也强制只打印脱敏摘要；完整 raw 不出现在终端。请保留私有 JSONL，不把它或凭据上传到聊天、工单或 PR。

## 资料内容与失败边界

`historyCaptures` 包含完整日线数组，不再只保存最后5根。每个采样仍保留供应商 timestamp、实际适配器 receivedAt、原始 OHLC/volume/turnover 字符串、tradeSession，以及 RAW/UNKNOWN/UNVERIFIED。页面保留请求起止和本机收录时间；capture 绑定 source、锁定 SDK5.2.0、symbol、market、请求端点和起止日期。历史 `tradingDays`、`halfDays` 数组按页完整保留，不能据此臆造开闭市时段。

`SAMPLED` 只表示全部计划内请求已经返回。`coverage`、`capability` 和时间锚点始终 UNKNOWN；零结果也不证明休市、停牌、权限正常或完整覆盖。历史最终状态不会因“日期已经过去”变为 CONFIRMED，量不会自动乘100。供应商午夜标签保持原值，不直接变成会话开盘时间。

重复或冲突记录全部保留在请求顺序中。原 `fetchDailyHistory` 不再用 timestamp Map 覆盖较早记录。逐页诊断及服务器读取按证券、周期、timestamp 比较除 receivedAt 外的原始内容：不同内容的同根记录拒绝后续候选转换；同值重复被显式列出且仍在完整样本数组里，不能被悄悄当作额外会话。后续审核/构建还应拒绝未解释的重复。

失败或超时保留已写的早期页，并标记 capture 为 INCOMPLETE。最后一条 JSONL 检查点缺失、被截断或尚未终结时，读取不能退回更早的成功快照。输入文件上限256 MiB，最终检查点上限16 MiB；每页日线/日历数组各有1000条硬上限，超过时明确失败，不截断伪装成功。

## 服务器代码消费

`apps/server/longbridge-history-input.ts` 只提供服务器代码函数：

- `readLongbridgeHistoryCapture(path, {symbol, from, through})` 从固定私有路径选择最后完整检查点中的唯一匹配 capture。
- `prepareLongbridgeHistoryCandidates(capture, {symbol, market})` 供固定服务器配置直接消费已选 capture。

两者输出精确 capture 内容哈希、scope、所有样本、历史日历页、接收时间范围和重复 timestamp；同时保留完整 capture。读取拒绝错误来源/SDK、身份或范围不匹配、缺页/页顺序错误、不完整状态、无效接收时间、日历越界及冲突样本。哈希证明本地内容一致性，不证明供应商签名或来源可信。读取不开启 SDK、不访问网络、不写数据库，也没有 HTTP 上传/认证接口。

后续 EOD 构建必须独立绑定受审计的历史端点权限、明确单位、最终状态适用范围、原始 timestamp 锚点、逐日 CalendarDay 会话及完整公司行动资料。SDK 交易日期列表本身没有历史会话时段。RawBar 转换只能在这层审核后完成，再由既有标准化/价格基准/完整会话检查重验；capture 的 UNKNOWN 不可被自行提升为生产证据。

## 隔离验证

测试使用本地 SDK 形状夹具，覆盖分页边界、原始数值/时间保留、超过5条样本、重复与冲突、缺页、截断尾部、私有文件、失败检查点、超时后的迟到响应以及默认 probe 回归。测试不配置真实凭据、不连接供应商、不代表实际主机/账户/权限验收通过。
