# 实施接口契约

共享 JSON 类型以 packages/contracts/index.ts 为准，价格为字符串，时间为 UTC 毫秒；Bar.time 特例为图表 UTC 秒。所有 JSON 错误返回 {error:string,code:string}。

- GET /api/session → {authenticated:boolean,configured:boolean,demo:boolean}
- POST /api/login {password} → {ok:true}；POST /api/logout
- GET /api/bootstrap → Bootstrap
- GET /api/candidates → CandidatePage；含 candidates、coverage、asOf、rules、universeRevision、computedAt、evaluatedAt、cacheHit、marketCoverage、workerHealth
- GET /api/universe → {rows,universeRevision,limits}；容量区分应用上限、供应商已验证上限和本地剩余
- POST /api/universe/import {rows:[{symbol,market,name?,tags?,note?}],expectedRevision} → {results,imported,existing,duplicates,universeRevision,limits}；单批最多 100 行、128 KB，去重后核算容量，全批验证并原子写入
- POST /api/universe {symbol,market,name?,tags?,note?,expectedRevision?} 添加人工标的 → Instrument 与 universeRevision；DELETE /api/universe/:id {expectedRevision?}；PATCH /api/universe/:id {tags,note,expectedRevision?}。旧客户端可省略版本，新界面所有写入携带版本
- GET /api/settings/screening → {version,current,defaultParameters}；未确认时 version=0、current=null
- POST /api/settings/screening {confirmed:true,expectedVersion,parameters:{minimumAdv20:{US,CN},adrMinPct,adrMaxPct,limitPerMarket}} → ScreeningSettings；追加不可变规则版本，旧 expectedVersion 返回 409。兼容旧 {confirmed:true}，只首次确认默认值，重试不覆盖最新参数
- POST /api/demo/seed 显式载入合成数据（只在 demo 启动配置允许时）
- GET /api/instruments/:id/bars?period=1D|1m|5m → {bars:Bar[],ema9:(string|null)[],ema21:(string|null)[],ema50:(string|null)[],avwap:(string|null)[],synthetic:boolean}
- POST /api/plans PlanInput → Plan；POST /api/plans/:id/versions {...PlanInput,expectedVersion} → Plan
- POST /api/plans/support-preview {instrumentId,anchorTime,primarySupport,supportSelections,sessionDate?} → SupportSnapshot；只接受支撑选择，EMA/ATR/AVWAP 价格与 ready 状态均由服务端核算
- POST /api/plans/:id/risk → RiskResult；POST /api/plans/:id/activate {expectedVersion} → {plan:Plan,risk:RiskResult}；POST /api/plans/:id/pause {expectedVersion} → Plan
- POST /api/funds {...Funds,expectedGeneration:number} → Funds（新建 expectedGeneration=0）
- POST /api/instruments/:id/price-proposal {kind:'POINT',displayPrice:string} 或 {kind:'STEP',price:string,steps:integer} → {price,tick,instrumentRevision,rounded,basis}；按服务端证券 tick 规范化，仅返回草稿提议，不写计划
- GET /api/events?limit=50&before=cursor 或 &after=cursor → EventPage；最多 50 条 DecisionEventSummary，含 counts、beforeCursor、afterCursor、feedCursor、feedEpoch、feedRevision
- GET /api/events/:id → DecisionEvent；完整冻结依据仅按需读取
- GET /api/events/stream?after=feedCursor → SSE event: events、data: EventFeedBatch、id: feedCursor；重连优先使用 Last-Event-ID；游标失效发 event: reset 并关闭连接，登录失效发 event: auth-expired
- POST /api/events/:id/read → {ok:true}
- POST /api/events/:id/feedback {kind:'TAKEN'|'SKIPPED',note,actualPrice?,actualQuantity?,actualTime?,expectedRevisionId?} → {ok:true}；界面提交当前已读版本，无历史时传 null，过期版本返回 409 并保留草稿
- GET /api/events/:id/feedback → {revisions:FeedbackRevision[]}；追加修订，保留实际输入和偏离原因，不改写原事件
- GET /api/events/:id/input → 归档判断输入
- GET /api/events/:id/replay → {status:'MATCH'|'MISMATCH'|'UNSUPPORTED',checks,reasons,original,replayed,inputHash,algorithmVersion,coverage}；校验原始 JSON 哈希后重放，不写入记录、通知或资金
- GET /api/market/status → MarketWorkerStatus；采样状态与水位独立于实时能力，liveEligible=false
- GET /api/demo/plans/:id/runtime → {runtime:RuntimeProgress|null}（仅演示模式）
- POST /api/demo/plans/:id/runtime/start {expectedVersion,expectedAttemptId} → {runtime:RuntimeProgress}；只准备服务端合成序列
- POST /api/demo/plans/:id/runtime/step {expectedVersion,expectedAttemptId,expectedStep,count?:1..20} → {runtime:RuntimeProgress}；逐输入原子提交，进度冲突返回 409；不接受客户端行情或门控结论
- POST /api/demo/plans/:id/replay（仅演示模式）→ {events:DecisionEvent[]} 产生明确标记的合成回放结果，不伪装实时信号

所有写请求携带 X-Requested-With: PullbackLab。命令可携带 Idempotency-Key；生产通过 Cookie 会话认证。前端遇到409保留表单输入并要求重新读取。

股票池版本为完整标的、标签、笔记和证券规则内容的哈希；导入、编辑、删除在写事务内核验。批量输入错误返回 422 和逐行 results，不写入任何行；版本冲突返回 409 和最新 universeRevision。重复项保留原标签、笔记和历史标识。美股允许省略 .US；A 股必须带 .SH 或 .SZ，不推测交易所；有历史计划的标的不允许删除。

CandidateRow.manual / origin 表示来源身份，screeningStatus 表示算法结论。人工行始终 status=MANUAL 且 rank=null，即使算法结果为 PASS；筛选列表只排名非人工 PASS。dataCutoff 为实际参与计算的最后日线 UTC 秒，knownAt 为已纳入输入的最晚接收 UTC 毫秒；未闭合、未来发生或未来接收的输入不参与。health 给出缺失历史、未验证、合成和排除原因；turnoverBasis 为 PROVIDER / ESTIMATED / MISSING，金额币种来自 instrument.currency。coverage/marketCoverage.ready 只表示指标预热量足够，不表示真实数据权限、连续性或复权已验证。

computedAt 是候选计算时间，evaluatedAt 是此次读取时间，均不能替代行情截止。缓存键包含完整源数据、规则、股票池和当前可见输入；命中缓存也重新读取 workerHealth。worker POLLING 不代表实时能力就绪。前端刷新同时核验候选、bootstrap、股票池版本一致，避免旧内容与新版本编号混用。

规则参数保存十进制文本：ADV 必须为正，ADR 范围满足 0 ≤ min ≤ max ≤ 100，每市场上限为 1–30 的整数。规则仍属于 C 类工程预设，修改阈值不会改变 EMA/ADR/RS 公式。新建或显式修订计划冻结 screeningRuleSnapshot；旧计划和判断归档不回填、不重算。旧确认标志升级为版本 1 时 confirmedAt=null、confirmationBasis=LEGACY_CONFIRMED_FLAG，不生成虚假历史确认时间。

真实能力未验证时 activate 返回明确数据阻断，演示模式可运行明确标记的合成尝试。API 禁止让客户端直接提交通过结论。

PlanInput.supportSelections 可选 EMA9/EMA21/EMA50/AVWAP，或带 id、label、price 的 HORIZONTAL；多条 EMA 只算一个家族。Plan.supportSnapshot 为服务端生成的只读版本 2 快照。至少两个容差内家族且含 EMA 或 AVWAP，同时具有完整日线、ATR、规则及复权证据，才允许合成观察。预览的 sessionDate 应与待保存计划相同；冻结依据修订或旧计划缺快照时，启用检查要求显式保存新版本。

审计的 MATCH 只说明所归档输入可复现。算法未知或缺少完整冻结结构时返回 UNSUPPORTED；哈希、输入序列、状态或事件不一致时返回 MISMATCH。coverage 分别标明触发核和最终风险是否重新计算，不能将早期冻结风险门结论的重用解释为独立重新获取行情和资金。
