# Pullback Lab 技术实施方案与任务拆解

> 本文为需求与规划快照。当前交付状态请见 [验收报告](acceptance.md)。

版本：v1.0。日期：2026-10-12。对应需求：MVP 需求与核心算法 v0.2。

建议用 React、TypeScript、常驻 Node.js 服务和 SQLite 构建个人私有应用。先交付日线研究和可复现计算，再开放经数据能力验证的收盘提醒，最后按逐笔证据开放盘中模式。浏览器关闭后，服务端仍应监测；主机停机或断网时暂停，不补发历史机会。

本方案不增加原 MVP 的产品范围。保留三个工作页、最多 100 只研究标的、最多 10 只同时监测、只读行情和手动交易。既有 [KEJ-38](https://linear.app/kejunz/issue/KEJ-38/接通双市场行情与能力门控) 至 [KEJ-43](https://linear.app/kejunz/issue/KEJ-43/完成三页闭环与回放验收) 作为功能主任务；新增基础任务和子任务负责具体实施。当前交付为方案与工单，尚未创建应用仓库、运行接入探针或验证实盘能力。

## 1 需求分析结论

v0.2 已明确指标公式、双模式触发、风险约束及 T01–T25。继续开发的主要风险在数据证据与状态持久化，不在增加更多指标。

| 缺口 | 为什么会影响实现 | 本方案处理 |
| -- | -- | -- |
| 前一根 K 线必须在下一根开始前确认 | 实际确认消息通常晚于边界到达，严格照字面实现会跳过大量候选 | 增加参考就绪时间；明确候选期内的有限等待，不能倒放早先成交制造信号 |
| 普通前复权与仅拆股调整没有对应证明 | 日线、AVWAP 和原始盘中价格可能不在同一尺度 | 保存原始量价及可知时点的公司行动；证据不足时禁用正式指标或计划 |
| 逐笔推送不等于连续有序成交证据 | 无顺序或连续性保证时无法判断先回踩后突破 | 单独验收逐笔能力，不用客户端自增编号冒充供应商顺序 |
| 去重键包含 ref_bar_id | 同一尝试换参考后仍可能产生第二次入场事件 | 增加按 attempt_id 的入场事件唯一约束 |
| 已交易之后如何处理其他预留 | 直接释放预留会将已花掉的现金再分配一次 | 使资金快照失效；刷新后按固定顺序重算活动计划 |
| 截止时刻与最终消息接收时刻混合 | 正常闭合消息可能被先执行的过期任务误删 | 分开市场截止时间、接收宽限和当前可行动资格 |
| 恢复监测与“第一次回踩”冲突 | 断线期间可能已发生首次回踩 | 不把恢复后的第二次回踩冒充会话首次；旧尝试停止，人工新建恢复尝试 |

这些是本产品的 C 类工程补充。它们不改变 Martin Luk 原话的归属，也不构成收益结论。第 5 节明确列出与 v0.2 字面表述有差异的地方，先由规范任务固化后再实现。

## 2 技术选型与运行结构

| 部分 | 选择 | 目的与边界 |
| -- | -- | -- |
| 前端 | React + Vite + TypeScript | 三页单页应用；表格、设置抽屉、图表与计划表单 |
| 图表 | TradingView Lightweight Charts | K 线、指标线和自定义图元；支撑区与锚点交互由应用实现，不依赖完整 TradingView 平台 |
| 服务端 | 受支持的 Node.js LTS + Fastify + TypeScript | 同一常驻进程承载 HTTP、行情连接、会话调度和事件处理；实施时锁定版本与锁文件 |
| 数值 | decimal.js，统一数值封装 | 外部与数据库传十进制字符串；核心禁止 Number 金额运算；图表坐标才转 Number |
| 数据 | SQLite + 显式 SQL 迁移 + better-sqlite3 | 单机、单服务实例、短事务；不在网络文件系统共享数据库 |
| 推送 | REST 命令与查询 + SSE 事件流 | 浏览器只展示服务端结果；事件可重取，前端按 event_id 去重 |
| 验证 | Vitest + fast-check + Playwright | 固定样本、性质测试、真实 SQLite 并发测试和三页端到端测试 |
| 交付 | 单机持久卷 + 进程守护 + HTTPS 入口 | 可选择 Linux 主机或兼容的 Mac mini；实际部署地区决定市场能力 |

这是适合当前规模的工程选择，不是已完成的基准测试结论。暂不引入 PostgreSQL、Redis、消息中间件或微服务。未来只有多实例写入、容量压测失败或高可用要求改变时，再评估替换。

模块划分建议为 apps/web、apps/server、packages/domain、packages/contracts、packages/market-data、packages/storage。它们是同一仓库的模块，不是六个独立部署服务。domain 内只放确定性函数和状态转移，不读系统时钟、不联网、不写数据库。时间、行情、配置和现有状态全部由调用者传入。

核心数据流为：行情适配器校验输入 → 保存标准化输入及可知时间 → 指标或状态计算 → 同一数据库事务提交计划状态、风险预留、事件和提醒 → SSE 通知浏览器。筛选与回放使用相同 domain 核心，回放没有写入生产提醒的出口。

数值封装固定至少 40 位有效精度、舍入策略和算法版本。金额与数量的合法取整发生在业务边界；指标显示不反向影响判断。保守预算取整须明确币种最小单位。计算精度本身也必须纳入版本和性质测试，不能把“用了 decimal”当成绝对无误差。

## 3 行情接入的可行性与阻断条件

Longbridge 是首选候选数据商，尚未成为已验证依赖。官方价格页明确区分 OpenAPI 与 App 行情权限，并标明 A 股实时行情受中国大陆 IP 限制，其他地区为 15 分钟延迟。\[S1\] 连接 ChatGPT 行情插件不会自动给应用签发可部署凭据。

官方 K 线接口提供 OHLCV、成交额、周期、复权参数和常规交易时段选择。普通查询最多返回最近 1,000 根，长历史需要历史接口；按账户等级还有股票数额度。\[S2\] 适配器应缓存固定池，只为监测中的证券订阅分钟数据，实际数量取产品上限和账户额度的较小值。频率额度、当月唯一证券额度、同时订阅额度分别记录，不能用“最多 10 个计划”替代供应商计费或配额模型。

官方 SDK 文档提供确认 K 线的配置与确认字段，但必须在部署主机实测确认时间、重复更新和断线后的行为。\[S3\] LIVE_CLOSED_BAR 不只检查一个布尔值：还要验证会话、完整性、延迟、报价新鲜度与证券规则。

逐笔协议的 PushTrade 包有 sequence，包内包含多笔成交。\[S4\] 本次查阅的 Node 类型页中，PushTrades 只列 trades，不能据此宣称应用已取得包级顺序号。\[S5\] 即使拿到 sequence，也不能未经协议证明就假定每包加一，或据此证明全市场无漏单。需要明确其作用域、包内顺序、重连语义、成交类型和缺口检测方法。缺少其中任一关键证据时，INTRABAR_CROSS 维持关闭。协议层薄适配、补充 SDK 暴露字段或另一个只读数据源均是后续选择；本次不预先承诺其中一条一定可行。

复权枚举只区分原始与前复权，公开枚举不足以证明它等于“仅拆股调整”。\[S6\] 首版正式数据采用原始 K 线，加已验证的拆股因子：历史价格除以比例、股数乘以比例。保存生效日、资料发布时间、系统接收时间、来源和版本。现金分红不能当拆股处理。若无法证明某一窗口内公司行动完整，筛选和 AVWAP 标为未知；可浏览原始研究图，但不能降格为“算法通过”。人工导入已核验因子可作为有限池补充，必须保留证据，不能从价格跳变猜比例。该阻断同样适用于 EMA、ATR 和收益率，不能只挡 AVWAP。

一次先行探针需要输出：所用 SDK 与运行时版本、部署地区、授权类别、两市场支持证券清单、日线与分钟样本、最终 K 线延迟分布、逐笔顺序可见性、数据单位、拆股样本、当前额度和未支持项。没有凭据时，任务可以交付探针程序和明确的受阻报告，但不能把市场实时接入标为完成。成本记录实际报价与上限，不假定免费，也不自动购买。

## 4 数据模型与接口契约

| 数据组 | 主要字段或表 | 不变量 |
| -- | -- | -- |
| 证券与日历 | instruments、instrument_rule_versions、market_sessions | 交易所与代码共同标识；规则带生效期和证据；存 UTC，展示交易所时间 |
| 行情证据 | raw_inputs、bar_revisions、adjustment_versions、capability_observations | 保留 event_time、received_at、ingest_seq、provider_seq（可空）、revision、session；未知不能填零 |
| 筛选 | universe_versions、rule_versions、screening_runs、indicator_states | 股票池和数据截止点可还原；EMA 种子与算法版本固定 |
| 研究与计划 | anchor_versions、setup_versions、plan_versions、attempts | 版本不可变；运行状态单独保存；页面编辑用 expected_version 避免双标签覆盖 |
| 资金 | account_snapshots、reservations、risk_checks | 按币种现金、基础币种风险与同标的敞口；同一快照原子预留 |
| 事件与记录 | decision_events、notifications、notification_ack、record_revisions | 技术事件、提醒、用户反馈分开；反馈更正不覆盖原计划 |

数据库价格和金额用 TEXT 保存规范化十进制字符串，数量以明确单位的整数保存；禁止 SQL 将 TEXT 隐式转浮点后计算预算。时间可用 UTC 整数毫秒，但供应商时间精度也要保存，不能补出不存在的毫秒。输入去重与事件去重分开，不能仅凭相同价格和时间戳删除两笔真实相同成交。

建议接口：GET /api/capabilities、GET /api/screening-runs/latest、GET /api/instruments/:id/bars、POST /api/plans、POST /api/plans/:id/versions、POST /api/attempts、POST /api/attempts/:id/pause、POST /api/account-snapshots、POST /api/events/:id/feedback、GET /api/events 和 GET /api/events/stream。创建与命令接口接受幂等键；修改携带 expected_version；冲突返回 409 和当前版本，前端保留输入。浏览器提交参数和人工选择，不提交可直接落库的“校验已通过”。

行情链路以一次常规交易会话为单位；5 分钟线从开盘对齐的完整 1 分钟线聚合，或使用已验收的原生 5 分钟线。每个运行固定一种来源。缺少构成分钟时禁止拼出完整 5 分钟线。已确认无成交与供应商丢数据分开；不填充虚构成交量。

原始输入只保存固定池研究所需历史和监测证券所需证据，不保存全市场逐笔。每次决策保留不可变快照及引用的输入片段；清理策略不得删除仍被事件引用的证据。先核验供应商允许的缓存与保存范围，再设保留期。若许可不能满足复现需要，列为数据源阻断，不能用一个无法展开的哈希冒充可复现输入。

## 5 必须固化的时序和状态补充

以下按本方案推荐值进入规范任务。C01、C02 和 C05 是对 v0.2 的明确收敛或修订；不能同时保留两套互相冲突的生产规则。

### C01 参考就绪时间

v0.2 要求在候选 b 开始前冻结 r。但 r.end=b.start 时，确认消息通常尚未到达。建议改为：r 必须是紧邻的、同会话同周期已闭合 K 线；允许在 b.start 后不超过已配置闭合延迟阈值（测试预设 30 秒）内确认。在任何本周期触发判断前冻结 r，并保存 ref_ready_at。不能拿更早一根替代，也不能使用 b 自身高点。

盘中模式只能使用同一候选 b 内、ref_ready_at 之后收到且时序合格的 x_prev 和 x_now 形成穿越，不能把就绪前的成交重新播放为实时机会。此前实时观察到的触碰可以保留，但触碰到穿越之间必须持续完整，补数不能恢复这段实时证据。收盘模式在 b 最终确认时判断，但参考必须已按上述期限就绪。超过期限跳过本候选；是否暂停整个尝试取决于完整性是否已丢失。后续参考修订使依赖计划暂停，不重写旧事件。

### C02 市场截止与接收宽限

候选线按开始时间选择周期，整根必须在首小时内。收盘模式以 b.end 是否不晚于等待截止和会话首小时截止判断市场时间资格。调度器在截止边界先停止接收新候选，再保留最后合格闭合线最多 30 秒的接收宽限；宽限结束后才终结 EXPIRED。迟于宽限只记历史命中。

时效精确判断为 received_at≤b.end+30 秒，等号有效。接收时间在入站时持久化，调度输入有统一序号；工作线程排队不能把按时到达改成迟到。即使该线在宽限内到达，当前数据、停止状态、计划版本、报价和资金快照仍必须合格才能提醒；已接收的止损触及先行处理。盘中事件必须发生在截止前，不能借用收盘宽限延长逐笔入场时间。停牌和数据暂停不延长首小时，也不自动重置 15 分钟等待；发生证据缺口按 C05 处理。

### C03 技术命中与风险阻断

先评估失效及判断回踩和突破必需的数据证据。一次因果成立的首次技术突破产生 TECHNICAL_TRIGGERED，并永久消耗该 attempt 的触发机会。入场区间、追高、当前报价新鲜度和风险校验作为独立门控，分别输出 PASS、BLOCKED 或 UNAVAILABLE。失败保留技术事件和原因，计划暂停；后续资金刷新或价格回落不能让旧突破重新发提醒。用户重试需要新 attempt_id。这也解决 v0.2 第 6 节与第 7.4 节对超入场区间事件处理不一致的问题。

ENTRY_TRIGGERED 表示该技术突破已通过当时全部检查，最多一条；TAKEN 只由用户反馈产生。应用内可以显示风险阻断事件，但不能把它写成“计划通过”。必需数据不足时不生成伪造的技术命中，而是 DATA_PAUSED。

### C04 预留与资金快照

启用计划时按 Emax 加完整成本进行保守预留，保存 approved_q 和 allocation_order。触发价重算只可减小数量，事务内用新预留替换该计划自己的旧预留，其他计划预留照常扣除，防止自我重复占用。

TAKEN 事务将快照标为 STALE；即使未填写实际价格和数量，也不能继续分配其现金。旧预留标为待核对，其他计划停止资金通过提醒。用户确认新快照后，按原 allocation_order 在同一事务重建未消费的活动计划预留，数量不超过各自 approved_q；资金不足则缩量或暂停，不能让线程竞争决定先后。新快照必须说明已含所有已交易记录的外部影响。

SKIPPED 以及触发前的 INVALID、EXPIRED、USER_PAUSED 释放预留；触发前 DATA_PAUSED 保留预留直到用户暂停或期限结束。已经发出提醒但待用户处理的计划，不因首小时结束自动释放占用；用户明确跳过后才释放，已交易则按 STALE 流程处理。历史提醒在失效、过期或资金变更后标为不可据此行动。资金确认表单携带快照代际；表单打开后若又发生 TAKEN，旧确认请求返回 409，不能覆盖 STALE。B_pool 仅代表待完成计划的预留，不展示为全部实际持仓风险。恢复备份后快照一律 STALE，活动监测一律暂停。

### C05 首次回踩与恢复

“会话首次回踩”需要从会话开始到现在的完整证据。若计划开盘后启用，必须先验证此前未触碰；发现已触碰则本次首次模板不能启用，不能把创建时间之前的数据忽略。

出现未能修复的断线缺口后，旧尝试不能自动恢复成 WAIT_RETEST。继续研究可补历史数据，但旧条件不补发。若用户另建恢复尝试，必须显示“恢复后新尝试”，具有独立 ID 和 evidence_epoch，并重新取得价格严格高于 U、完整参考及新回踩证据。不能复用昨日收盘或断线前的上方证据。它不声称是该会话第一次回踩。首次模板与恢复模板标记分开，旧 15 分钟窗口不被重置。

### C06 追高和已知低点

闭合模式只在已完整覆盖的常规会话数据上维护 LOD_known。需要同时保存其覆盖截至时间。若候选闭合后收到更晚的新鲜价格，检查用 Echeck 与同一决策时已知、可证明完整的低点覆盖；不能混用盘前低点或在收盘后回写历史。无法满足需求中的会话低点完整性时暂停该限制所依赖的行动提醒，不猜一个低点。

### C07 提醒的有效性与投递

每次入场检查先写一条事件。风险预留、attempt 消费、ENTRY_TRIGGERED 与通知记录同事务提交；任何一步失败，全部回滚。数据库以 attempt_id 对 TECHNICAL_TRIGGERED 和 ENTRY_TRIGGERED 各设部分唯一索引，另保留含 ref_bar_id 的普通事件幂等键。无参考线事件用非空 event_key，避免 NULL 绕过唯一性。

通知记录本身就是待投递队列。网络推送采用至少一次投递，客户端 event_id 去重；断线按游标重取。写入连接成功不等于用户已看到，已读状态由客户端确认。浏览器离线时事件仍保存；重新打开显示事件发生时的结果及“历史／待重新检查”状态，不将积压通知变成新的行动机会。

## 6 风险计算与并发事务

风险求解器严格实现 v0.2 的四项约束：单笔风险、总风险池、报价币种现金、同标的敞口。费用函数、汇率、报价和证券规则全部带版本或时间；未知费用不默认零。

合法数量集合为 0 或 q_min+k×q_step，取满足全部约束的最大数量。只有已证明成本随数量单调时才能二分；其他情况使用有界保守搜索，超出计算预算返回未通过，不返回未经完整检查的近似值。最后对结果和下一个合法数量分别验算，验证可行性及最大性。

启用与触发处理使用 BEGIN IMMEDIATE 短事务，读取快照版本、现有预留、计划版本，计算并写入。事务内不调用供应商或其他网络服务。开始前取得外部行情，提交前检查数据年龄、连接健康和输入版本。SQLite 忙、满盘或提交失败时不推送成功；重试有界并保留失败原因。\[S7\]

数据库使用 WAL、foreign_keys、合理 busy_timeout 和同步持久化设置。运行时须读取 sqlite_version()，选择包含官方 WAL-reset 修复的版本，例如 3.51.3 或更新稳定版，或明确包含官方回移修复的版本。\[S8\] 不以 npm 包版本代替运行库检查。

## 7 三页交互与最小记录

候选池按市场分别显示通过、未知和排除状态。将覆盖数、股票池版本、最新已完成交易日、实际／估算成交额放在可见位置。人工加入不改变自动筛选结果身份。设置抽屉首次要求确认 C 类筛选参数；个人资金、风险比例和现金不预填合成示例。

标的与计划使用服务端指标。点击已完成日线选择锚点；拖动支撑、止损和入场区间只产生预览，保存后生成新版本并暂停旧计划。明确显示日线 AVWAP 的截止日，不随分钟视图重算。前端坐标转换、吸附价格跳动与键盘数值输入应相互校验。界面必须解释无法启用的具体原因，而不是只把按钮置灰。

提醒与记录同时呈现技术命中、风险阻断、入场提醒和用户反馈。用户标记已交易或已跳过；实际入场摘要可空，填入计划外价量时保留并标偏离。更正采用追加记录，用户能看到当前值和历史更正，不能改变原风险计算。

图表图元使用 Lightweight Charts 的扩展机制。\[S9\] 图表库只负责绘制；不能由绘图代码再计算另一套 EMA 或风险。上线时核查实际采用版本的开源许可和署名要求。

## 8 验证与发布标准

保留 T01–T25，增加以下 U 类工程场景。每项同时检查计算值、状态、原因、提醒数和数据库读回结果。

| 编号 | 场景 | 必须成立的结果 |
| -- | -- | -- |
| U01 | r 在 b 开始后 1 秒确认，早于确认的成交曾穿越 T | ref_ready_at 被保存；旧成交不能造成盘中提醒；超 30 秒参考不参与本候选 |
| U02 | 最后合格 K 线在截止后 2 秒／31 秒收到 | 2 秒可继续新鲜度与风险检查；31 秒仅历史命中；调度顺序不改变结论 |
| U03 | 第一次突破风险阻断，随后现金增加；再到另一参考线 | 本 attempt 零入场提醒，不以旧突破重试；新尝试须显式建立 |
| U04 | 两次参考变化、并发消费者与重启重投 | 同 attempt 最多一条技术突破和一条入场事件；无参考事件同样不能重复 |
| U05 | 标记 TAKEN 未填实际价量，再保存新资金快照 | 其他计划先阻断；新快照含该外部影响并按固定顺序重建预留，旧快照不复用 |
| U06 | 双标签编辑同一计划，同时进行触发 | 一个编辑返回 409；旧版本不能与新资金或新支撑混算；输入不丢失 |
| U07 | 事件提交后推送失败，浏览器离线后恢复 | 原事件重投且只显示一次；过期结果显示历史，已读仅由确认产生 |
| U08 | 开盘后启用或断线，缺口内已回踩 | 不误称首次；旧尝试不自动重置，恢复尝试另存身份 |
| U09 | 拆股资料后来修订，历史种子或图表窗口改变 | 历史事件保持原输入；研究重算另起版本；未来资料不进入历史决策 |
| U10 | 触发时数据库锁、满盘、进程在提交前后终止 | 预留、状态、事件、通知全有或全无；不能出现未落库的成功提醒 |
| U11 | 备份恢复或迁移失败 | 可恢复完整记录；资金快照失效、监测暂停；不重复推送旧机会 |
| U12 | 盘中数据同秒多笔、重复包、非连续编号、缺顺序号 | 不按本地编号或时间排序虚构先后；不满足证据就关闭该模式 |
| U13 | 打开资金确认表单后又发生 TAKEN | 旧表单提交返回 409，不能恢复脏快照或覆盖其他活动预留 |
| U14 | 已有待处理入场提醒，首小时结束，然后重复 SKIPPED | 截止时占用保留；明确跳过仅释放一次，不重新提醒 |

性质测试覆盖：风险／现金／敞口不超约束；任何 q 都属于合法集合；触发数量不超过批准量；任一尝试最多一个入场事件；缺必需证据不能通过；更改显示精度不改变业务结果。并发测试使用独立 SQLite 连接或独立进程和同步屏障，不能仅在同一同步调用链连续调用两次后声称验证了竞争。

每次回放的输入包包含资金快照代际、其他计划预留集合或其不可变版本、报价、汇率、费用、证券规则、日历、参考就绪时间、evidence_epoch、截止水位和定时器事实。只保存行情与规则不足以复现风险结果。回放不能查询“最新 K 线”替换当时数据。

验证分三层：合成固定样本验证算法；供应商原始样本验证契约；实际部署探针验证市场能力。三类证据分开报告。合成测试通过不证明真实实时能力，真实行情可读也不证明规则收益。

性能验收沿用 100 池、10 监测、缓存页面 P95≤2 秒、合格输入进入应用到落库 P95≤5 秒。记录硬件、样本量、窗口、上游延迟、处理延迟与失败数。故意混入无效数据验证先阻断后谈性能；连续监测压测不能只测空队列。

## 9 部署与日常运行

同一台主机运行一个应用实例、一个行情上下文和本地持久数据库。进程守护负责自动重启；启动时先恢复快照、核验迁移、行情权限和会话，再进入监测就绪状态。单用户登录采用成熟的服务端会话方案；HTTPS、HttpOnly/Secure Cookie 和服务端会话保护私有接口及 SSE，写接口另校验 CSRF 请求标记。请求 Origin 不再与部署地址或本地上游地址比较，以支持隧道访问。密钥仅服务端保存，不进仓库、浏览器、诊断导出和日志。

如部署在 Mac mini，需在实际系统上验证 Node、SQLite 驱动及行情 SDK 的架构兼容性，同时确保目标监测时段主机不休眠。选择 Linux 时采用有持久磁盘的常驻部署。方案不依赖某个云厂商，也不由 GitHub Pages 或浏览器承担后台任务。禁止同时开启两个进程争抢同一账户的监测职责。

日志以 plan_id、attempt_id、event_id、市场、规则版本、输入时间及阻断码串联；页面仅显示可理解原因。健康信息区分服务存活、数据连接、各市场授权、新鲜度、缺口、时钟偏差、资金状态、积压和磁盘。心跳超时即阻断，不以 HTTP 正常响应代替行情正常。

备份使用 SQLite Online Backup API 或经过验证的同等一致性方法，不能只复制正在 WAL 模式写入的主数据库文件。\[S10\] 上线前完成迁移前备份、恢复演练与回滚检查。备份包括必要的输入证据和算法版本，但不打包密钥。

## 10 实施顺序与工单组织

先完成规范补充、工程基础和数据探针。指标与风险纯函数可在合成样本上并行开发。真实研究功能以数据口径通过为门槛；闭合提醒以实时行情与事务链路通过为门槛；盘中模式以有序连续成交证据通过为额外门槛。

三个里程碑建议为：M0 规范与接入证据；M1 日线研究与风险计划；M2 条件提醒与可验证交付。它们表示能力门槛，不是假定工期。盘中适配受外部能力阻断时可交付明确标注的研究／收盘版本，但不能把未完成的盘中能力工单标 Done。

本次已创建 17 项任务，其中 2 项共同基础、15 项功能子任务。所有新任务保持 Backlog，并设置优先级、所属里程碑和实际 blockedBy 关系。

| 任务 | 范围 | 父任务 | 前置任务 |
| -- | -- | -- | -- |
| [KEJ-44](<https://linear.app/kejunz/issue/KEJ-44/%E5%9B%BA%E5%8C%96%E6%97%B6%E5%BA%8F%E4%B8%80%E6%AC%A1%E5%B0%9D%E8%AF%95%E4%B8%8E%E8%B5%84%E9%87%91%E5%BF%AB%E7%85%A7%E7%9A%84%E5%B7%A5%E7%A8%8B%E8%A7%84%E8%8C%83>) | 固化时序、一次尝试与资金快照的工程规范 | 共同基础 | 无 |
| [KEJ-45](<https://linear.app/kejunz/issue/KEJ-45/%E5%BB%BA%E7%AB%8B-typescript-%E5%BA%94%E7%94%A8%E9%AA%A8%E6%9E%B6%E6%95%B0%E5%80%BC%E5%A5%91%E7%BA%A6%E4%B8%8E-sqlite-%E6%8C%81%E4%B9%85%E5%8C%96%E5%9F%BA%E7%A1%80>) | 建立 TypeScript 应用骨架、数值契约与 SQLite 持久化基础 | 共同基础 | [KEJ-44](https://linear.app/kejunz/issue/KEJ-44/固化时序一次尝试与资金快照的工程规范) |
| [KEJ-46](<https://linear.app/kejunz/issue/KEJ-46/%E9%AA%8C%E8%AF%81-longbridge-sdk%E9%83%A8%E7%BD%B2%E5%9C%B0%E5%8C%BA%E6%8E%88%E6%9D%83%E4%B8%8E%E7%9C%9F%E5%AE%9E%E8%A1%8C%E6%83%85%E8%83%BD%E5%8A%9B>) | 验证 Longbridge SDK、部署地区、授权与真实行情能力 | [KEJ-38](https://linear.app/kejunz/issue/KEJ-38/接通双市场行情与能力门控) | [KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础) |
| [KEJ-47](<https://linear.app/kejunz/issue/KEJ-47/%E5%AE%9E%E7%8E%B0%E8%A1%8C%E6%83%85%E6%A0%87%E5%87%86%E5%8C%96%E5%B8%82%E5%9C%BA%E4%BC%9A%E8%AF%9D%E4%B8%8E%E9%97%AD%E5%90%88-k-%E7%BA%BF%E6%8C%81%E4%B9%85%E5%8C%96>) | 实现行情标准化、市场会话与闭合 K 线持久化 | [KEJ-38](https://linear.app/kejunz/issue/KEJ-38/接通双市场行情与能力门控) | [KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础) |
| [KEJ-48](<https://linear.app/kejunz/issue/KEJ-48/%E5%BB%BA%E7%AB%8B%E6%8B%86%E8%82%A1%E5%9B%A0%E5%AD%90%E5%8E%9F%E5%A7%8B%E9%87%8F%E4%BB%B7%E4%B8%8E%E5%A4%8D%E6%9D%83%E4%B8%80%E8%87%B4%E6%80%A7%E5%A5%91%E7%BA%A6>) | 建立拆股因子、原始量价与复权一致性契约 | [KEJ-38](https://linear.app/kejunz/issue/KEJ-38/接通双市场行情与能力门控) | [KEJ-47](https://linear.app/kejunz/issue/KEJ-47/实现行情标准化市场会话与闭合-k-线持久化) |
| [KEJ-49](<https://linear.app/kejunz/issue/KEJ-49/%E5%AE%9E%E7%8E%B0%E7%A1%AE%E5%AE%9A%E6%80%A7%E6%8C%87%E6%A0%87%E6%9C%89%E9%99%90%E6%B1%A0%E7%AD%9B%E9%80%89%E4%B8%8E%E7%AE%97%E6%B3%95%E5%9B%BA%E5%AE%9A%E6%A0%B7%E6%9C%AC>) | 实现确定性指标、有限池筛选与算法固定样本 | [KEJ-39](https://linear.app/kejunz/issue/KEJ-39/实现收盘筛选与确定性指标) | [KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础) |
| [KEJ-50](<https://linear.app/kejunz/issue/KEJ-50/%E5%AE%8C%E6%88%90%E5%80%99%E9%80%89%E6%B1%A0%E9%A1%B5%E9%9D%A2%E4%B8%8E%E5%8F%AF%E8%A7%A3%E9%87%8A%E7%9A%84%E8%A7%82%E5%AF%9F%E5%88%97%E8%A1%A8>) | 完成候选池页面与可解释的观察列表 | [KEJ-39](https://linear.app/kejunz/issue/KEJ-39/实现收盘筛选与确定性指标) | [KEJ-49](https://linear.app/kejunz/issue/KEJ-49/实现确定性指标有限池筛选与算法固定样本)、[KEJ-47](https://linear.app/kejunz/issue/KEJ-47/实现行情标准化市场会话与闭合-k-线持久化) |
| [KEJ-51](<https://linear.app/kejunz/issue/KEJ-51/%E5%AE%9E%E7%8E%B0%E6%94%AF%E6%92%91%E5%BF%AB%E7%85%A7%E8%AE%A1%E5%88%92%E7%89%88%E6%9C%AC%E4%B8%8E%E9%A6%96%E6%AC%A1%E5%9B%9E%E8%B8%A9%E5%B0%9D%E8%AF%95%E7%AE%A1%E7%90%86>) | 实现支撑快照、计划版本与首次回踩尝试管理 | [KEJ-40](https://linear.app/kejunz/issue/KEJ-40/实现手动锚点与回踩计划) | [KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础)、[KEJ-49](https://linear.app/kejunz/issue/KEJ-49/实现确定性指标有限池筛选与算法固定样本) |
| [KEJ-52](<https://linear.app/kejunz/issue/KEJ-52/%E5%AE%9E%E7%8E%B0%E6%97%A5%E7%BA%BF%E4%B8%8E%E5%88%86%E9%92%9F%E5%9B%BE%E8%A1%A8%E6%89%8B%E5%8A%A8%E9%94%9A%E7%82%B9%E5%92%8C%E8%AE%A1%E5%88%92%E6%95%B0%E5%80%BC%E7%BC%96%E8%BE%91>) | 实现日线与分钟图表、手动锚点和计划数值编辑 | [KEJ-40](https://linear.app/kejunz/issue/KEJ-40/实现手动锚点与回踩计划) | [KEJ-51](https://linear.app/kejunz/issue/KEJ-51/实现支撑快照计划版本与首次回踩尝试管理)、[KEJ-49](https://linear.app/kejunz/issue/KEJ-49/实现确定性指标有限池筛选与算法固定样本) |
| [KEJ-53](<https://linear.app/kejunz/issue/KEJ-53/%E5%AE%9E%E7%8E%B0%E5%8D%81%E8%BF%9B%E5%88%B6%E9%A3%8E%E9%99%A9%E6%B1%82%E8%A7%A3%E5%99%A8%E4%B8%8E%E5%90%88%E6%B3%95%E6%95%B0%E9%87%8F%E7%BA%A6%E6%9D%9F>) | 实现十进制风险求解器与合法数量约束 | [KEJ-41](https://linear.app/kejunz/issue/KEJ-41/实现风险数量与资金预留) | [KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础)、[KEJ-44](https://linear.app/kejunz/issue/KEJ-44/固化时序一次尝试与资金快照的工程规范) |
| [KEJ-54](<https://linear.app/kejunz/issue/KEJ-54/%E5%AE%9E%E7%8E%B0%E8%B5%84%E9%87%91%E5%BF%AB%E7%85%A7%E4%BB%A3%E9%99%85%E5%8E%9F%E5%AD%90%E9%A2%84%E7%95%99%E4%B8%8E%E5%B7%B2%E4%BA%A4%E6%98%93%E5%90%8E%E9%87%8D%E5%BB%BA>) | 实现资金快照代际、原子预留与已交易后重建 | [KEJ-41](https://linear.app/kejunz/issue/KEJ-41/实现风险数量与资金预留) | [KEJ-53](https://linear.app/kejunz/issue/KEJ-53/实现十进制风险求解器与合法数量约束)、[KEJ-51](https://linear.app/kejunz/issue/KEJ-51/实现支撑快照计划版本与首次回踩尝试管理) |
| [KEJ-55](<https://linear.app/kejunz/issue/KEJ-55/%E5%AE%9E%E7%8E%B0%E6%94%B6%E7%9B%98%E7%A1%AE%E8%AE%A4%E7%8A%B6%E6%80%81%E6%9C%BA%E5%8F%82%E8%80%83%E5%86%BB%E7%BB%93%E4%B8%8E%E6%88%AA%E6%AD%A2%E8%BE%B9%E7%95%8C%E8%A3%81%E5%86%B3>) | 实现收盘确认状态机、参考冻结与截止边界裁决 | [KEJ-42](https://linear.app/kejunz/issue/KEJ-42/实现双模式触发与提醒) | [KEJ-51](https://linear.app/kejunz/issue/KEJ-51/实现支撑快照计划版本与首次回踩尝试管理)、[KEJ-47](https://linear.app/kejunz/issue/KEJ-47/实现行情标准化市场会话与闭合-k-线持久化) |
| [KEJ-56](<https://linear.app/kejunz/issue/KEJ-56/%E9%AA%8C%E8%AF%81%E9%80%90%E7%AC%94%E8%BF%9E%E7%BB%AD%E6%80%A7%E5%B9%B6%E5%AE%9E%E7%8E%B0%E5%8F%97%E8%83%BD%E5%8A%9B%E9%97%A8%E6%8E%A7%E7%9A%84%E7%9B%98%E4%B8%AD%E7%AA%81%E7%A0%B4>) | 验证逐笔连续性并实现受能力门控的盘中突破 | [KEJ-42](https://linear.app/kejunz/issue/KEJ-42/实现双模式触发与提醒) | [KEJ-55](https://linear.app/kejunz/issue/KEJ-55/实现收盘确认状态机参考冻结与截止边界裁决)、[KEJ-46](https://linear.app/kejunz/issue/KEJ-46/验证-longbridge-sdk部署地区授权与真实行情能力) |
| [KEJ-57](<https://linear.app/kejunz/issue/KEJ-57/%E5%AE%9E%E7%8E%B0%E4%BA%8B%E5%8A%A1%E4%BA%8B%E4%BB%B6%E5%85%A5%E5%9C%BA%E5%94%AF%E4%B8%80%E7%BA%A6%E6%9D%9F%E4%B8%8E-sse-%E6%8F%90%E9%86%92%E6%81%A2%E5%A4%8D>) | 实现事务事件、入场唯一约束与 SSE 提醒恢复 | [KEJ-42](https://linear.app/kejunz/issue/KEJ-42/实现双模式触发与提醒) | [KEJ-55](https://linear.app/kejunz/issue/KEJ-55/实现收盘确认状态机参考冻结与截止边界裁决)、[KEJ-54](https://linear.app/kejunz/issue/KEJ-54/实现资金快照代际原子预留与已交易后重建) |
| [KEJ-58](<https://linear.app/kejunz/issue/KEJ-58/%E5%AE%8C%E6%88%90%E6%8F%90%E9%86%92%E8%AE%B0%E5%BD%95%E9%A1%B5%E9%9D%A2%E5%8F%8D%E9%A6%88%E6%9B%B4%E6%AD%A3%E4%B8%8E%E4%B8%89%E9%A1%B5%E9%97%AD%E7%8E%AF>) | 完成提醒记录页面、反馈更正与三页闭环 | [KEJ-43](https://linear.app/kejunz/issue/KEJ-43/完成三页闭环与回放验收) | [KEJ-57](https://linear.app/kejunz/issue/KEJ-57/实现事务事件入场唯一约束与-sse-提醒恢复)、[KEJ-52](https://linear.app/kejunz/issue/KEJ-52/实现日线与分钟图表手动锚点和计划数值编辑)、[KEJ-50](https://linear.app/kejunz/issue/KEJ-50/完成候选池页面与可解释的观察列表) |
| [KEJ-59](<https://linear.app/kejunz/issue/KEJ-59/%E5%BB%BA%E7%AB%8B%E5%86%B3%E7%AD%96%E8%BE%93%E5%85%A5%E5%BF%AB%E7%85%A7%E7%A1%AE%E5%AE%9A%E6%80%A7%E5%9B%9E%E6%94%BE%E4%B8%8E%E5%AE%8C%E6%95%B4%E9%AA%8C%E6%94%B6%E6%8A%A5%E5%91%8A>) | 建立决策输入快照、确定性回放与完整验收报告 | [KEJ-43](https://linear.app/kejunz/issue/KEJ-43/完成三页闭环与回放验收) | [KEJ-58](https://linear.app/kejunz/issue/KEJ-58/完成提醒记录页面反馈更正与三页闭环)、[KEJ-48](https://linear.app/kejunz/issue/KEJ-48/建立拆股因子原始量价与复权一致性契约) |
| [KEJ-60](<https://linear.app/kejunz/issue/KEJ-60/%E5%AE%8C%E6%88%90%E5%8D%95%E7%94%A8%E6%88%B7%E7%A7%81%E6%9C%89%E9%83%A8%E7%BD%B2%E5%A4%87%E4%BB%BD%E6%81%A2%E5%A4%8D%E4%B8%8E%E9%80%90%E5%B8%82%E5%9C%BA%E5%8F%91%E5%B8%83%E9%97%A8%E6%A7%9B>) | 完成单用户私有部署、备份恢复与逐市场发布门槛 | [KEJ-43](https://linear.app/kejunz/issue/KEJ-43/完成三页闭环与回放验收) | [KEJ-59](https://linear.app/kejunz/issue/KEJ-59/建立决策输入快照确定性回放与完整验收报告)、[KEJ-46](https://linear.app/kejunz/issue/KEJ-46/验证-longbridge-sdk部署地区授权与真实行情能力) |

指标任务与风险求解器在工程基础完成后可并行开发。它们使用合成输入验证，不等待真实账户授权。真实研究发布仍由拆股与行情契约把关。盘中适配为独立条件任务；完整验收包括其纯算法样本，但未获真实数据能力时保持模式关闭及工单受阻。

建议首先推进规范任务、工程基础和行情探针，即 [KEJ-44](https://linear.app/kejunz/issue/KEJ-44/固化时序一次尝试与资金快照的工程规范)、[KEJ-45](https://linear.app/kejunz/issue/KEJ-45/建立-typescript-应用骨架数值契约与-sqlite-持久化基础)、[KEJ-46](https://linear.app/kejunz/issue/KEJ-46/验证-longbridge-sdk部署地区授权与真实行情能力)。项目入口：[https://linear.app/kejunz/project/pullback-lab-回调交易研究-018616dd62c7](<https://linear.app/kejunz/project/pullback-lab-%E5%9B%9E%E8%B0%83%E4%BA%A4%E6%98%93%E7%A0%94%E7%A9%B6-018616dd62c7>)

## 11 依据与未决输入

需求基线：[https://linear.app/kejunz/document/mvp-需求与核心算法-v02-f23c3cf32de0](<https://linear.app/kejunz/document/mvp-%E9%9C%80%E6%B1%82%E4%B8%8E%E6%A0%B8%E5%BF%83%E7%AE%97%E6%B3%95-v02-f23c3cf32de0>)

以下官方资料于 2026-10-12 查阅。接口字段说明不等于本应用已经完成接入。交易所规则仍需按具体证券和生效日期核验，本方案不补造数量单位、税费或卖出资格。

* S1 Longbridge 行情权限与地区限制：[https://open.longbridge.com/pricing](<https://open.longbridge.com/pricing>)
* S2 K 线接口：[https://open.longbridge.com/docs/quote/pull/candlestick](<https://open.longbridge.com/docs/quote/pull/candlestick>)
* S3 SDK 配置与确认 K 线：[https://longbridge.github.io/openapi/python/reference_all/](<https://longbridge.github.io/openapi/python/reference_all/>) 及 [https://longbridge.github.io/openapi/nodejs/classes/PushCandlestick.html](<https://longbridge.github.io/openapi/nodejs/classes/PushCandlestick.html>)
* S4 逐笔推送协议：[https://open.longbridge.com/docs/quote/push/trade](<https://open.longbridge.com/docs/quote/push/trade>)
* S5 Node 逐笔类型：[https://longbridge.github.io/openapi/nodejs/classes/PushTrades.html](<https://longbridge.github.io/openapi/nodejs/classes/PushTrades.html>)
* S6 复权与交易时段枚举：[https://open.longbridge.com/docs/quote/objects](<https://open.longbridge.com/docs/quote/objects>)
* S7 SQLite 事务：[https://www.sqlite.org/lang_transaction.html](<https://www.sqlite.org/lang_transaction.html>)
* S8 SQLite WAL 与运行库修复版本：[https://www.sqlite.org/wal.html](<https://www.sqlite.org/wal.html>)
* S9 Lightweight Charts 图元扩展：[https://tradingview.github.io/lightweight-charts/docs/plugins/intro](<https://tradingview.github.io/lightweight-charts/docs/plugins/intro>)
* S10 SQLite 一致性备份：[https://www.sqlite.org/backup.html](<https://www.sqlite.org/backup.html>)
* 数值库行为：[https://mikemcl.github.io/decimal.js/](<https://mikemcl.github.io/decimal.js/>)

开发开始仍需要实际应用仓库、部署位置、应用可用的行情凭据与授权、完整公司行动来源、逐证券交易规则、实际费用和汇率来源。可以先完成合成数据验证与界面，不为这些缺口擅自选用个人资金值，也不把未验证的市场能力预设为可用。
