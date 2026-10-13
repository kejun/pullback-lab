# 独立 EOD 日线研究接线

本路径将完整的已审计历史日线接到候选筛选与日线图/AVWAP，不要求实时分钟或逐笔资格。US/CN 共用同一套历史完整性规则；CN 实时 adapter 的禁用仍保留。默认没有真实审计配置，代码和夹具测试不证明真实行情已经通过。

## 从采集到研究

1. 使用原有应用凭据环境，按 [有界历史采集](bounded-history.md) 在私有新文件中采集明确日期窗口。先确认 API 历史权限、额度和留存许可，避免与其他采样并发。新窗口模式保存每页全部 RAW 日线和同范围 tradingDays/halfDays，最多1096个自然日，始终保留 UNKNOWN/UNVERIFIED。短 probe 的末5根样本不能作为完整窗口。
2. 服务器代码用 `readLongbridgeHistoryCapture` 读取最后完整检查点；其结果的 `capture` 是资料，不是信任凭证。缺页、冲突、非终态或截断尾部拒绝，不回退到较早的成功检查点。
3. 对明确的 SDK5.2.0 `historyCandlesticksByDate` / Day / NoAdjust / Intraday 路径独立审核历史权限、来源、单位、当地午夜时间标签及已完成历史的最终状态语义。审核逐日会话（含休市、DST、半日市/午休）、至少250个开市日的完整日线及整个范围的公司行动。供应商日期列表不包含历史时段，SDK confirmed 不认证本历史端点。官方单次拆股公告不能替代完整窗口账本。
4. 由代码审查后的固定服务器依赖制作 `EodResearchInput {capture, review}`，安装在 `apps/server/production-research-config.ts`。`review.history` 复用现有 CapabilityEvidence、CalendarDay、AdjustmentDataset、证券规则及 actionEvidenceVersion；`review.endpoint` 绑定该端点的单位与最终历史/时间锚点口径。capture 的精确哈希由读取器重算，不接受外填哈希作为认证。审核时刻不得早于完整采集和所用资料的知识时刻。
5. 在已存在的研究池证券上安装；未知证券身份不自动创建，已核验但变化的证券规则拒绝覆盖。用户无需手写250根、猜拆股比例或填 `verified:true`。真实原始资料仍在私有文件/数据库，不放入公共 PR；配置路径必须由服务器代码固定，不从 HTTP 或任意 env 模块路径读取。

已有真实资料尚未审计时，继续保持默认 undefined/off。只有经过独立审计后，运维者才在原授权范围内使用：

```bash
PULLBACK_RESEARCH_MODE=longbridge-eod npm run market:check
```

当前默认槽未安装时，应返回 `AUDITED_RESEARCH_CONFIGURATION_REQUIRED`。静态检查不连接 SDK，不打开/迁移数据库；真正启动仍按原单实例锁、迁移前备份和鉴权流程进行。启动会再次核对本地公司行动最新代际与窗口事实。`PULLBACK_CLOSED_BAR_MODE` 可以继续 off，研究路径本身不打开任何网络连接。`market:check` 输出单独的 research 部分，`liveEnabled:false` 保持明确。

## 历史转换和价格基准

历史端点单位单独绑定，不能从证券下单手数或 CN 实时聚合的100股含义推断。只在审核为 LOT 时做精确股数转换，SHARE 保持不变；成交额不随量单位或拆股机械改变。原始 SDK 整数精度以安全整数为界，分数或超界原始量拒绝。原始量、UNVERIFIED 标签、转换因子、端点审核 ID 和 raw finality 一起保存在标准化 raw 快照中。

逐根当地午夜标签须匹配该日期已审核的实际会话；原始标签继续保留。完整采集日历的开市/休市日期必须与逐日审核记录一致，halfDays 列表也须明确一致。未知历史时段和未解释重复拒绝，不能补造零量蜡烛。每根实际收到时间不得早于会话收盘。

EOD 窗口包含 through 当天；若末日为已核休市日，价格基准采用窗口内最后完成会话的收盘，不能外推到未来会话或借用以后收到的修订。日线内部拆股、缺公司行动覆盖和未来发布/接收资料仍按原 fail-closed 规则处理。仅拆股调整保留精确反向股数及实际成交额，现金分红不机械改变它们。

## 信任与实时隔离

SQLite schema13 新增不可变 `eod_contexts` 与当前 `eod_sources`。它们与 `closed_sources`、分钟流和 tick 包分离；启动不带静态 EOD 配置就清除当前研究资格，旧审计历史仍保留。研究筛选和日线图使用完整数据哈希、证券规则哈希、有效期、真实知识时刻和公司行动代际重新校验；到期/修订会使缓存失效。

公司行动导入在原事务内同时撤销 EOD 来源；无活动计划也撤销。重启旧配置、系统时钟退回或手工声明 COMPLETE 都不能恢复旧来源。重新审核、显式绑定最新本地版本且与当前行动/撤回事实一致，才可再次安装。

EOD 上下文强制清除 realtimeEntitlement/completeMinutes/sequence/continuousTrades 和实时延迟资格。计划支撑就绪、monitor activate/recover 仍使用原 `trustedClosedSupport` 与实时门；不会因为筛选 PASS 或图上显示“日线依据已核验”而获得正式提醒。没有新增上传或设置 API 可以认证资料。

## 验证与仍缺的真实输入

隔离测试验证 US/CN、周末/DST/半日市、端点量单位、全量 raw 哈希、逐日覆盖、权限/单位/最终历史未知拒绝、过期缓存、公司行动撤销/显式重审、启动无配置、实际鉴权 HTTP 图表及无实时资格。备份/恢复测试使用非空 EOD 审计资料。浏览器场景展示桌面与390px来源说明；最终结果以准确提交的 CI 为准。

仍须实际主机采集、账户历史权限/留存/额度、真实单位/时间锚点及历史最终状态审计、完整日历与行动账本。正拆/反拆/现金分红的真实跨周期核对仍属于 KEJ-48，逐笔连续性仍属于 KEJ-56。此路径不把这些未完成验收改为通过。
