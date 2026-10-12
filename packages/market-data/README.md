# 行情边界

当前包含可测试的标准化与持久化原语、明确合成的演示数据、Longbridge 5.2.0 只读 SDK 适配器和部署探针。尚无实际部署主机的行情凭据与供应商验收证据。两市场能力保持 UNKNOWN；这些模块通过测试不表示已接通实时行情。

## 已实现

- `resolveSession`：只接受带来源、版本、可知时间的显式日历；Intl 处理纽约夏令时；休市、半日和午休由输入记录决定，缺日历不猜。
- `normalizeBar`：原始价量、单位换算、完整时段、最终状态及接收时间验证。最终分钟结束后 30 秒边界包含等号；更晚数据标历史。
- `aggregateFiveMinuteBars`：按开盘对齐；不跨午休，不合成缺失或未确认分钟。保留实际成交额，拒绝混证券、来源和调整版本。
- `adjustForSplits`：知识截止点与价格基准截止点分离。仅应用当时已接收且已生效的拆股，价格除以比例、股数乘以比例；保留原始价量、成交额与版本。现金分红不改量；公司行动覆盖未经验证即拒绝正式计算。
- `BarRepository`：SQLite 持久保存每次原始接收、首次接受的修订，以及重复或冲突证据。后续修订不覆盖历史输入。
- `assessCapability` 与 `monitoringGate`：权限、地区、时效、分钟完整性、最终状态、时钟、逐笔连续性和证券规则分别设门槛。
- `reserveQuota`：100 只研究、10 只监测为两市场共享上限，取供应商配额更小值；区分每秒请求、月度唯一证券和同时订阅。实际供应商额度未知即拒绝预留。

`BarRepository.ingest` 返回 `invalidatesActivePlans`。调用方必须在同一数据库事务中保存输入并暂停依赖旧证据的活动计划。月度额度使用的月界、外部剩余额度和订阅释放由常驻服务管理；这里不根据本地空计数推定供应商剩余额度。

## 合成数据

`demoInstruments` 与 `generateDemoBars` 仅可在显式演示模式下使用。300 根日线是合成的工作日时间轴，不是交易所历史；2026-10-09 首小时分钟也是合成数据。每根标有 synthetic 与 synthetic 调整版本。合成证券的规则验证仅对合成模型成立，不可复制给真实证券。

## 只读探针

```sh
node --import tsx scripts/probe.ts
node --import tsx scripts/probe.ts --symbols AAPL.US,600519.SH --observe-seconds 65
```

使用 `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN`。`PULLBACK_DEPLOYMENT_REGION` 仅记录用户声明，不视为部署地区核验。CLI 要求明确列出至多两只已授权证券，不自动选股、不购买行情、不调用交易账户、持仓或订单接口。

退出码：`2` 表示能力尚未验证或缺配置；`1` 表示探针执行失败。当前没有返回“已接通”的路径：即使读取成功，也只生成样本和未解决清单。无凭据时不会建立 SDK 行情上下文。

查询历史 K 线没有确认字段，所以返回 `finality: UNKNOWN`，不能仅因时间已过就直接提升为闭合输入。推送使用 Confirmed 模式并保存 SDK 的 `isConfirmed`，但仍需实测其时间戳、最终状态、重连与修订语义。Node SDK 5.2.0 `PushTrades` 类型没有包级顺序号；本实现不会从本地序号制造 LIVE_TICK 能力。

真实使用还需：有效分钟与价格单位证据、公司行动完整来源、交易规则与日历小时、额度与缓存许可、价格和成本上限，以及目标主机连续观测。`fetchDailyHistory` 每个分页都要求调用方先通过额度准入；探针原始样本不能直接进入生产计算。
