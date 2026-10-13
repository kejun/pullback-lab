# CN 分钟来源诊断：先分端点，再解释单位

本片补齐实际只读采样到来源诊断的路径。它不生成正式 `Bar`、不写数据库、不修改日历、不授予任何实时能力。CN 生产适配器的双层 `LONGBRIDGE_CN_MINUTE_UNIT_UNSUPPORTED` 拒绝保持。KEJ-46/48 的真实验收继续进行中。

## 为什么不能把分钟 volume 全部乘 100

锁定 `longbridge@5.2.0`，官方源码提交 `b2f749a3c68cc4f05642b37fc790fb711d2dfb13`：

- [`subscribeCandlesticks` 首次订阅](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L662-L779)先拉 1000 条历史 RAW 数据，再订阅 Quote/Trade。重复订阅可直接返回既有内存数组，返回值也不一定是纯历史 seed。
- [历史 Candlestick 解析](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/types.rs#L838-L855)保留 volume；[同桶更新](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/crates/candlesticks/src/market.rs#L240-L282)直接累加 trade.volume。回调后无法恢复这两路各自的单位。
- [CN 参数](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/crates/candlesticks/src/markets.rs#L40-L52)使用 `lot_size=100`；[Trade 的成交额解释](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/types.rs#L170-L212)为 price × volume × lot_size。这证明 SDK 算法怎样解释输入，并不认证所有历史端点的实际量单位。
- [分钟分支按 SecurityBoard 区分](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L1143-L1171)：CN 指数/板块使用 Quote；日线使用 QuoteDay。不能从 SH/SZ 后缀、数字代码或下单 lotSize 推定所有量都来自 Trade 分支。

例如在分别已确认的解释下，历史 seed 1000 股与逐笔 2 手应分别换成 1000、200 股。先将原量混成 1002，再整体乘 100 会得到错误的 100200。本例只证明算术设计，不断言实际历史 seed 是股，也不证明两份记录没有重叠。

## 实际采样命令

在项目目录、复用现有应用凭据的终端环境运行。不要把密钥写到命令或聊天；命令读取实际 `process.env`，不会自动读取 `.env`。先确认没有其他采样/应用实时订阅同时占用该 OpenAPI 的额度；不要为了本命令未经确认停止别的程序。以下会进行明确列出证券的只读行情请求，没有账户或交易调用：

```bash
report_dir=$(mktemp -d)
npm run --silent probe -- --symbols 688008.SH --minute-sources --observe-seconds 60 --output "$report_dir/minute-sources.jsonl"
```

仅允许 1–2 个六位 SH/SZ 代码、1–120 秒、锁定 SDK5.2.0。该选项必须独立运行，不能与 `--history-from/--history-through` 混用。输出文件 create-only、0600；目录和完整原始资料只留本机。终端强制白名单摘要，可回传摘要，不回传完整 JSONL。退出码 2 表示仍需审核（包括成功采样或缺凭据），1 表示采样/输出不完整；它不会以退出码 0 宣称真实能力通过。

本路径复用套餐、静态资料、报价、日历预检，保存 SecurityBoard。分钟 seed 分别直接请求 `ctx.candlesticks` 的 1m/5m、各最多60条、RAW/Intraday，绕过本应用60秒缓存；不调用 `subscribeCandlesticks` 或读取其混合尾桶。[锁定 Rust 方法](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/context.rs#L866-L891)发远端 GET_SECURITY_CANDLESTICKS，这不保证服务端无缓存或样本最终不可修订。

随后仅订阅 `SubType.Trade`，保留各 Node 回调的原始数量、价格、事件时间、真实接收时间、交易类别/会话和数组顺序。最多512个回调、4096笔；整包越界/异常会停止收集、保留此前完整原始包并标 INCOMPLETE，不截断尾包伪装成功。清理有界，迟到订阅确认尝试退订；未决或清理失败的 context 不能重用。本命令不是长期连续采集器，断开/进程中断不能据此恢复行情覆盖。

私有报告在每个既有请求完成时写入检查点。逐笔观察结果在有界观察和清理结束后写入；强制终止进程可能没有最后一段内存中的逐笔包。失败后不可把此前部分检查点当完整窗口。

## 读懂诊断

- 原始量始终标 UNVERIFIED，端点分开。历史 seed 同时列出“若为股”和“若为100股手”的精确候选，程序不选择其中之一，也不反推单位。
- 仅静态资料 board 与后缀匹配已知 CN 股票板、普通 Intraday 逐笔，才输出 SDK_CN_TRADE_BRANCH 的 ×100 算术解释，仍明确 `SDK_INTERPRETATION_NOT_VERIFIED`。未知 board、指数、板块、矛盾 board 或不支持的交易类别不赋确定候选。
- 归一化原语使用精确十进制，在各原始端点进入可能的组合之前转换，并保留 original。其输出带不同类型标签，重复乘100拒绝；`sdkMixedCandlesticks` 无法拆分原始血缘，一律拒绝。成交额不会随量再次乘100。
- 历史 seed 与逐笔落入相同候选桶时，明确报告重叠并拒绝合并。SDK初始推送可能包括旧交易；缺少供应商身份/覆盖语义时不能猜去重。即使没有观察到重叠，仍不能证明连续性。
- Node callback 没有暴露供应商包序号，报告固定 `providerSequence:null`。[公开协议确有 sequence](https://open.longbridge.com/docs/quote/push/trade)，但只暴露字段仍不足以证明序号作用域、缺口或重连连续性。报告不以本地数组序号代替它。
- 摘要只含固定状态、计数与理由，不含原始价量、交易时间、路径、套餐详情或异常文本。EMPTY/无逐笔不等于权限失败，收盘、午休或观察窗口太短都可能没有事件。

## 15:00 是明确保留的边界记录

[官方 CN 时间测试](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/crates/candlesticks/tests/cn_time.rs#L7-L24)明确：1m 的 15:00、15:01、15:09:59 事件映射至15:00，15:10不映射；上午11:30已不映射。5m测试同样覆盖15:00/15:01，[共用算法](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/crates/candlesticks/src/market.rs#L138-L167)推得相同10分钟接受边界。

这只是 SDK 对事件时间的映射，不是交易所延长交易，也不是“15:10定时确认”。本片保持原 timestamp：

- 常规标签只给待审的候选桶，不认证当日开市/最终性。
- 历史 seed 的精确15:00标签单独保留，经济含义 UNKNOWN、canonicalInterval=null；不继承逐笔 timeout 解释。
- Trade 15:00–15:09:59可记录 SDK 算法映射为15:00，同时保留原事件时间；不把该范围变成正式交易区间。
- seed 15:01不套逐笔映射，不移动到15:00或14:59。1m/5m边界条均不删除，不凑造另外4根分钟以满足五合一。

现有 `normalizeBar` 和 `auditPriceBasis` 的真实会话区间要求不变；15:00边界记录不能进入普通 RawBar 或被过滤后声称全批通过。[confirmed 来自客户端 AppendNew](https://github.com/longbridge/openapi/blob/b2f749a3c68cc4f05642b37fc790fb711d2dfb13/rust/src/quote/core.rs#L1220-L1281)，不能推出最后一个桶会按时获得最终确认。此模式不输出以 timestamp+60秒作为真收盘时间的延迟结论。

## 尚待证明的具体契约

真实主机/账户的访问、地区/时钟、套餐/额度/留存许可；各历史端点和周期的实际量单位与时间锚点；15:00桶承载内容、收盘竞价和1m/5m如何对应、最后桶最终性/修订；初始推送、重叠/重复、断线回补的身份和覆盖。无需供应商使用项目自定义字段名，但必须有可审计的等价语义。源码算术、短观察和完整保存都不能代替这些保证。

可以先使用 PR23 的独立、已审计EOD研究路径；EOD资格不授权分钟或逐笔提醒。所有测试使用隔离 SDK形状夹具，无真实供应商/目标主机验收。
