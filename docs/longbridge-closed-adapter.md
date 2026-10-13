# Longbridge 正式闭合适配器：已接线代码与待验收事实

`LongbridgeClosedBarAdapter` 是 SDK 5.2.0 的真实只读运输实现。其输出直接进入已有 `ClosedBarRuntime`，不是另一个采样 CLI。当前交付只用 SDK 形状的隔离模拟验证；没有配置实际凭据、连接真实供应商、购买权限或部署目标主机。默认 `npm start` 不安装此适配器，两市场仍为 UNKNOWN。主入口现有静态审计服务器配置槽和 `market:check`，详见 [生产装配与本机检查](production-market.md)；单独设置环境开关不能授予能力。

## 服务器信任边界

复用既有 `ClosedBarContext` 与 `ProviderQuota`，没有新增 HTTP 证明上传、环境 JSON 或 `verified=true` 开关。只有经过代码审查的服务器入口能向 `createApp` 提供 `closedBarAdapterFactory: longbridgeClosedBarFactory(contexts, quota, env)`。工厂共享应用的 Store，不另建数据库或额度账本；`closedBarAdapter` 与 factory 不得同时提供。

`contexts` 不是用户配置模板，也不从历史上传、分钟采样隔离库或人工公司行动的 COMPLETE 声明自动生成。它必须引用实际探针报告、证券规则、完整日线及拆股来源的已审计身份。现有验证器要求权限/地区/单位/日历/闭合语义/延迟/时钟有效、规则已知、至少250根完成日线、同一价格基准、选取时已知；运行器冻结原始上下文及日线/规则哈希，后续计划固定 context ID。

本适配器额外要求 source 精确为 `longbridge-node-5.2.0`，证券代码与市场相符，最多十只服务器已登记研究标的，并清除所有逐笔连续/顺序能力声明。因此它最多是 CLOSE_CONFIRM，不开放 INTRABAR_CROSS。锁定 SDK 的 CN 实时聚合量具有已知的100股单位含义，而当前运输只实现原生 SHARE；CN 正式分钟入口因此明确拒绝 `LONGBRIDGE_CN_MINUTE_UNIT_UNSUPPORTED`，服务端布尔声明也不能覆盖这个矛盾。历史/日线端点单位不能由这条实时实现推导。地区不合格的 A 股、证据过期、未知单位或未知额度均不能打开 SDK 连接。凭据只在 start 时读取，错误不会回显秘密或供应商原文。

## 真实接线

`createApp({ closedBarAdapterFactory })` → SDK `QuoteContext` → 实时回调 → 既有 `ClosedBarSink` → 不可变 `closed_receipts` → 标准化与 `market_raw_inputs` → 尝试、风险复核及原有事务事件。

- 只使用 QuoteContext；无 TradeContext、账户、持仓和下单方法。
- Config 使用 Confirmed、关闭 overnight。报价先订阅，再订阅常规会话的一分钟蜡烛；握手过程中实际到达的回调保留，订阅方法返回的历史数组始终丢弃。
- 只接收 `isConfirmed === true`、Min_1、Intraday；SDK Date 被解释为已审计的一分钟起点。未知/非法时间、非安全整数成交量、异常 OHLC、提前确认或报价停牌状态使连接失效。
- 当前接口以已审计的 SHARE 与 RAW 合约转换分钟。`unitsVerified` 与 `finalityContractVerified` 的审计必须包含此具体端点的股数/成交额币种与尺度、分钟起点及推送未复权语义；公开文档的字段名不足以独自证明这些事实。
- 实际接收时间仍由运行器在回调交付时捕获。报价是常规时段最后成交价估计，不是可成交卖价。
- 此 SDK 蜡烛回调没有提供供应商修订号/可靠包序号（锁定实现的聚合推送 sequence 固定为0）。适配器固定标记 `sdk-unversioned-v1`，不制造递增版本；同一蜡烛内容变化进入已有冲突暂停路径，不改旧记录。
- 没有消息不能证明无成交。本适配器从不发出 noTrade、不补造 OHLC。缺分钟、迟到、修订以及队列完整性继续由原运行器阻断。

## 额度与关闭

`ProviderQuota` 必须是该账户已审计的限额。共同研究上限100、监测上限10再取供应商更低值；月唯一证券复用已有持久账本。精确的供应商剩余额度仍不能由本地计数证明。

历史采样 worker 与正式适配器不同时运行。服务器工厂拒绝 `PULLBACK_MARKET_WORKER=1`，并拒绝数据库记录的未停止采样通道。先正常停止旧服务；若其上次崩溃，请先在正式适配器未安装时，以采样关闭配置完成既有启动恢复，再正常停止并进行接线。不要手工编辑 SQLite 绕过门控。

所有订阅、退订和清理共用单一请求通道，保守限速每秒一次。关闭立即屏蔽旧回调；清理去重，先同步预留额度时隙，再按真实 SDK Promise 的结束顺序执行。超时只是停止等待，不会释放尚未结束的本地通道；晚到订阅成功后才执行排队退订。新连接在旧请求或清理未结束时被阻断。

SDK 没有显式 close/cancel 及连接代际通知。原运行器关闭等待有界；原生调用长期不结束时，不能宣称服务器已确认退订，只有本地回调已失效。队列清理不在稍后访问已关闭数据库；原生清理失败会禁止复用此 adapter。生产验收必须覆盖超时、进程退出及重启后的供应商订阅状态；代码测试不证明网络连接可靠性。每秒一次也意味着多标的启动可能达到运行器握手上限，需要在真实限额和延迟验收后为服务器设置有证据支持的有界超时，不放宽数据延迟门槛。

## 日线筛选和图表

已有运行器安装的精确上下文日线现在能用于候选计算；无需再伪装成 synthetic。只有证券规则哈希和完整日线哈希一致、来源仍在有效期内才标 `VERIFIED` / `PROVIDER`。人工观察身份独立保留，用户确认筛选参数仍是必要条件。

缓存键包含当前可信 context ID；过期/移除/变更后下一次读取变为 UNKNOWN，不使用旧命中。日线 AVWAP 采用相同可信判断，返回只读来源 ID、探针 ID、基准日期及到期时间。证据不足时图表仍可显示已有价格，但不计算声称已验证的 AVWAP，也不授予监测能力。人工历史上传的原有研究通道不变，不能授能正式运行。

此切片不自动采集、认证或更新250根真实日线。SDK 历史日线缺少本系统所需的全部证据，不能用一个成功请求把它升级为真实 EOD 已验收。

## 官方契约与无法自动推出的事实

核对日期：2026-10-13；代码依赖锁定 longbridge 5.2.0，未来网页和包变更须重新核验。

| 官方来源                                                                               | 可用事实                                       | 不足以证明                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| [开始使用](https://open.longbridge.com/docs/getting-started)                           | 时间戳 UTC 编码                                | 日线标签和分钟时间锚点的具体映射                         |
| [历史蜡烛](https://open.longbridge.com/docs/quote/pull/history-candlestick)            | NoAdjust、常规时段参数、最多1000条             | 历史日线最终状态、完整证券交易历史、股数单位、修订保证   |
| [闭合蜡烛推送](https://open.longbridge.com/zh-HK/docs/quote/push/candlestick)          | 当前网页描述 Confirmed 回调                    | 不修订、无丢失、空成交行为、断线连续性                   |
| [交易日](https://open.longbridge.com/docs/quote/pull/trade-day)                        | 最近一年内、至多一个月窗口的交易日与半日市列表 | 更早日历和逐日完整时段                                   |
| [交易时段](https://open.longbridge.com/docs/quote/pull/trade-session)                  | 当日市场时段                                   | 历史半日市小时；示例CN至14:57不能直接当全天15:00收盘规则 |
| [公司行动](https://open.longbridge.com/docs/fundamental/fundamental/corporate-actions) | SDK corpAction(symbol) 返回事件描述            | 结构化拆股比例、正确生效时刻、完整覆盖及空列表无拆股证明 |
| [Node SDK](https://longbridge.github.io/openapi/nodejs/classes/QuoteContext.html)      | 实际订阅、回调和退订接口                       | 逐笔包级 sequence 或显式关闭/取消能力                    |

### 锁定5.2.0实现与网页协议的区别

[官方锁定源码 b2f749a](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L662-L779)先取1000条 NoAdjust 历史，再订阅 Quote/Trade 并在客户端合并。[AppendNew 路径](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L1220-L1281)产生 `is_confirmed`，并把聚合推送的 sequence 设为0；它不是服务端不可变最终收据。[重连路径](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L880-L918)重新订阅且不请求 first push，没有该路径的历史回补保证。收到 confirmed、凑齐分钟数或本机短时观察均不能认证无丢失/最终不修订；完整性能力仍需独立且有效的契约证据，否则不得启用。

[CN市场参数](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/crates/candlesticks/src/markets.rs#L40-L52)是 lot_size=100，[成交聚合](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/types.rs#L188-L212)按 price×volume×lot_size 形成成交额而原样累加volume。这只证明此实时聚合分支的单位，不能认证历史种子、历史分钟或日线相同。当前没有安装相应端点转换契约，CN实时入口保持关闭。

[wire逐笔协议](https://open.longbridge.com/docs/quote/push/trade)本身有 sequence；不能说整个供应商协议没有序号。[Rust字段](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/push_types.rs#L188-L196)与[Node回调映射](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/nodejs/src/quote/context.rs#L123-L132)表明锁定 Node 回调没有暴露该字段；即便另加薄适配暴露它，也不能由“有序号”推导作用域、严格连续、重连epoch与回补规则。

## 真正接入前的最小验收清单

1. 用户先授权在指定目标主机做只读接入验收，并通过受支持的秘密管理方式自行配置应用 OpenAPI 凭据。聊天插件连接不等同于应用凭据；不要把 token 贴进聊天、工单、代码或报告。
2. 复用现有 probe 在目标地区采样，留存脱敏原文；独立核对该账户的 OpenAPI 套餐、供应商下限、费用/留存许可、时钟和实际闭合延迟。采样成功仍为 UNKNOWN。
3. 为具体证券和目标会话核对规则、250根以上日线及逐日交易日历，含美国DST/半日市、中国午休/收盘集合竞价；从可证明的来源核对拆股比例、覆盖区间与版本。当前 SDK 文本 corpAction、空结果或 ForwardAdjust 均不能代替它。
4. 审核已有 ClosedBarContext 的每项事实和引用，与所选数据、SDK版本、目标地区和有效期精确绑定。把经审查的构建过程放在服务器启动代码；不要给网页、上传文件或普通环境变量授予证据签发权。原始资料和现有审计结果只是输入，不能自行提升能力。
5. 在私有验收入口用上述 server factory 接到 createApp，按既有单实例锁/备份/恢复流程运行。先确认默认入口及所有缺证分支仍关闭，再在实际授权范围内验收订退、重复/修订/乱序/迟到/断网/重启/磁盘故障及长时间会话。先看持久回执、再看候选/图表和尝试，不以UI可点击证明权限。
6. 保存准确源码、脱敏探针与证据版本、全部测试和真实验收结果。只有事实全部通过才可考虑另行授权部署/启用；任一未知继续阻断。当前尚未执行以上真实步骤。
