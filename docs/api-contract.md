# 实施接口契约

共享 JSON 类型以 packages/contracts/index.ts 为准，价格为字符串，时间为 UTC 毫秒；Bar.time 特例为图表 UTC 秒。所有 JSON 错误返回 {error:string,code:string}。

- GET /api/session → {authenticated:boolean,configured:boolean,demo:boolean}
- POST /api/login {password} → {ok:true}；POST /api/logout
- GET /api/bootstrap → Bootstrap
- GET /api/candidates → {candidates:Candidate[],coverage:number,asOf:string}
- POST /api/universe {symbol,market,name?} 添加人工标的；DELETE /api/universe/:id；PATCH /api/universe/:id {tags,note}
- POST /api/settings/screening {confirmed:true}
- POST /api/demo/seed 显式载入合成数据（只在 demo 启动配置允许时）
- GET /api/instruments/:id/bars?period=1D|1m|5m → {bars:Bar[],ema9:(string|null)[],ema21:(string|null)[],ema50:(string|null)[],avwap:(string|null)[],synthetic:boolean}
- POST /api/plans PlanInput → Plan；POST /api/plans/:id/versions {...PlanInput,expectedVersion} → Plan
- POST /api/plans/:id/risk → RiskResult；POST /api/plans/:id/activate {expectedVersion} → {plan:Plan,risk:RiskResult}；POST /api/plans/:id/pause {expectedVersion} → Plan
- POST /api/funds {...Funds,expectedGeneration:number} → Funds（新建 expectedGeneration=0）
- GET /api/events → {events:DecisionEvent[]}；GET /api/events/stream → SSE data: DecisionEvent、id: event_id
- POST /api/events/:id/read → {ok:true}
- POST /api/events/:id/feedback {kind:'TAKEN'|'SKIPPED',note,actualPrice?,actualQuantity?,actualTime?} → {ok:true}
- POST /api/demo/plans/:id/replay（仅演示模式）→ {events:DecisionEvent[]} 产生明确标记的合成回放结果，不伪装实时信号

所有写请求携带 X-Requested-With: PullbackLab。命令可携带 Idempotency-Key；生产通过 Cookie 会话认证。前端遇到409保留表单输入并要求重新读取。

真实能力未验证时 activate 返回明确数据阻断，演示模式可运行明确标记的合成尝试。API 禁止让客户端直接提交通过结论。
