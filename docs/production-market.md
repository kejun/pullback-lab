# 生产行情装配与本机只读检查

本批把已有 Longbridge 5.2.0 只读 adapter 接到 `npm start` 使用的真正入口，并机械检查用于生产上下文的历史覆盖和价格基准。公开源、账户授权、端点单位/最终状态、目标主机地区及实测延迟仍必须独立审计；通过本检查不代表真实行情验收通过，不代替账户授权，也不开放下单。

## 本机先跑的短命令

在仓库根目录更新到通过 CI 的提交，使用应用原本的 Node 24+ 环境。不要同时运行多个 probe；如果设置页的历史采样正在运行，先由用户正常停止采样。probe 的独立请求不与正在运行的采样器共享本地额度账本；每秒最多一次串行采样也不能证明账户剩余额度充分。

```bash
npm run market:check
```

默认输出 `CONFIGURATION_VALID`、`mode:off`、`configured:false`、`liveEnabled:false`；仅证明关闭配置有效。命令不建立 Store，不获取服务锁、不迁移数据库、不读取凭据、不访问供应商。

用户已授权只读采样、应用自己的 OpenAPI 凭据已通过原启动方式进入当前进程环境时：

```bash
umask 077
report_dir=$(mktemp -d "${TMPDIR:-/tmp}/pullback-probe.XXXXXX")
npm run probe -- --symbols NVDA.US,688008.SH --observe-seconds 0 --output "$report_dir/checkpoints.jsonl" --summary
```

证券是本轮明确选择的只读验收样本，不是买卖建议或研究池默认值。主机物理地区可以在同一命令前设置 `PULLBACK_DEPLOYMENT_REGION=CN_MAINLAND`；它仅为声明，VPN/代理实际出口和供应商地域授权仍须核实，无须为此改变 VPN。

- probe 只读取 `process.env`，不会自动加载任意 `.env`。若摘要出现 `APPLICATION_CREDENTIALS_MISSING`，应复用应用原本的秘密加载方式，而不是把密钥贴入聊天或命令参数。Docker 安装应在应用容器环境执行，不能假定主机终端有容器的凭据。
- `--summary` 只改变终端输出；原 JSONL 检查点格式及默认 probe 行为不变。输出目录必须存在，文件必须是新路径；检查点以 0600/create-only 写入，保留在本机。终端只有固定字段/枚举、步骤计数和未经认证的时间差，不输出套餐原文、报价/蜡烛样本、原始错误、文件路径或环境值。可回传这段摘要；不要回传 JSONL、环境文件或整份原始日志。
- 退出码 2 表示能力尚未验收（可能已收样，也可能缺凭据）；退出码 1 表示请求或报告失败。`reportSaved:false` 表示没有完整的私有报告，不应据此声称证据齐全。
- `--observe-seconds 0` 仅取静态资料、历史及报价。常规开市后另用新目录/文件、`--observe-seconds 120` 观察闭合推送。收盘边缘或非交易时段的 EMPTY/零推送不证明无权限；通用 FAILED 也不能独自区分权限、网络和供应商错误。观察到的延迟仍依赖单位、分钟起点和主机时钟核验。

## 审计后安装到主入口

`apps/server/production-market-config.ts` 是静态导入、需要代码审查的服务器配置槽，仓库默认 `undefined`。它接收 `AuditedLongbridgeConfiguration`，其中每项 `LongbridgeContextInput` 复用现有 `RawBar`、`CalendarDay`、`AdjustmentDataset`、`CapabilityEvidence` 与证据 ID；不是新证据上传格式，也不签发事实真实性。

只有审计真实资料后才能在这个服务器模块中导入经审查的输入。普通用户不需要手写250根日线、猜拆股比例或填写一组 `verified:true`；接入工作应使用实际探针/持久原始资料、官方来源和明确审核结论来制作这个服务器代码依赖。不要从网页、历史导入、任意环境 JSON 或动态模块路径生成它。当前没有已审计的真实配置，单独设置开关必定拒绝。

`PULLBACK_CLOSED_BAR_MODE` 仅接受：

- `off`（默认）：不安装适配器，不读取配置资料，不打开供应商连接。
- `longbridge-close-confirm`：静态审计配置必须存在；合成演示和旧采样器必须关闭。先运行同一环境下的 `npm run market:check`，再由用户在已有授权范围内启动应用。

真正启动时先 `readStartupConfig`、`prepareProductionMarket`，再获取服务锁、迁移/恢复，最后把工厂传给 `createApp`。静态输入无效时在任何数据库写入之前退出；已有研究池/月累计余量/崩溃残留等依赖数据库的约束仍由工厂/运行器检查。只有 HTTP 启动成功后才开始连接；凭据仍由现有 adapter 延迟读取。原单实例锁、备份、运行恢复、Origin 和会话鉴权均保留。

同一源码与配置可用：

```bash
PULLBACK_CLOSED_BAR_MODE=longbridge-close-confirm npm run market:check
```

当前未装审计配置时应退出 2，代码为 `AUDITED_SERVER_CONFIGURATION_REQUIRED`。这条命令不会打开真实连接。已装配置时也只输出配置检查结果、上下文哈希/基准日期/有效期，`liveEnabled:false` 明确说明没有执行连接或实时验收。

## 历史完整性和价格基准

构建器从 `historyStartDate` 到目标 `basisDate` 逐个自然日要求显式日历，周末和休市也不能靠默认推断。按真实知识截止选版本，拒绝同知识时点冲突；每个此前开市会话必须恰有一根完整原始日线，至少250根。未知停牌/缺日会阻断，不能补造零量蜡烛。历史半日市、DST、中国午休和收盘集合竞价使用各自日期的原始会话记录，绝不外推今天的时段。

每根线须精确对应证券/来源/会话、RAW 和已核验 SHARE 单位、实际收盘起止、最终状态及接收时间；不同接口或市场的量不能统一猜为“股”。`normalizeBar` 重验价格和整数原始股数，再由既有 split-only 核心调整；原始数据、成交额和反向调整后的精确分数股数均保留。不能为了匹配供应商的整数前复权量而舍入。

盘前必须能够准备首分钟观察。新的 `adjustForScheduledSession` 将当时已知的资料投影到显式目标会话开盘基准，真实 `asOf` 不向未来移动；已公告且已收到、在开盘生效的拆分可应用，未来收到/未来发布的修订不能参与。原 `adjustForSplits` 的历史审计契约仍拒绝未来基准。公司行动覆盖须到目标收盘；已知日线内部或目标会话盘中拆分会阻断。覆盖声明是审计输入，不证明未来不会出现新事件，后续来源变化仍需使旧上下文/计划失效。

日线、日历和公司行动内容一起绑定历史 ID；最终仍通过既有 `validateClosedContext`。没有完整真实来源、权限、分钟语义/时钟证据时仍不能启用正式监测。供应商 `ForwardAdjust`、模糊描述、插件数据或空列表都不是 split-only 完整性证明。回购股不参与分派等复杂事件若参与股比例与除权参考价系数不同，必须单独核实，不能用参考价格反推统一拆分比例。

## 本批验证范围

专项覆盖：显式完整日历/缺周末/缺开市日、重复/冲突、DST/半日市/午休、异常 raw/单位/来源/未来接收、拆股覆盖、正向/反向及现金分红、已知开盘拆分与未来修订隔离、盘前递增时钟的真实生产工厂握手→计划启用→首根 confirmed 回调、水位，以及未配置主入口无数据库写入和脱敏摘要 CLI。

所有行情是标记清楚的 SDK 形状隔离夹具；没有在开发环境配置凭据或连接真实供应商。完整测试数量、提交/tree、准确 head CI 和独立评审见本批 PR。实际本机报告应另记，不与 CI 测试合并成“真实已验收”。

## 官方公司行动小样本与不应合并的事实

以下只证明特定行动及数学预期，不证明250日完整账本、SDK返回的股数单位/会话覆盖或本机验收。测试中的OHLC是明确的算术向量，不是真实行情通过记录。

- [NVIDIA 2024-05-22公告](https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2025)：10:1，6月7日收盘后派发股份，6月10日开始按新尺度交易。split-only 历史 P÷10、股数 V×10、实际 turnover 不变。[官方FAQ](https://investor.nvidia.com/files/doc_downloads/2024/06/nvidia-2024-stock-split_faq_investors.pdf)记载6月11日除息、每新股USD0.01、6月28日支付；FAQ在6月11日修订，不能冒充此前已收录。现金不再改变split因子。
- [Virgin Galactic 2024-06-12公告](https://investors.virgingalactic.com/news/news-details/2024/Virgin-Galactic-to-Effect-a-Reverse-Stock-Split/default.aspx)：1:20，6月14日17:00美东法律生效，6月17日开始新尺度交易。历史 P×20、V÷20。若原始股数为57,603,989，精确调整量是2,880,199.45；不能为了匹配某个前复权接口的整数2,880,199而舍入。本数值是精度回归向量，未认证为应用SDK行情。
- [贵州茅台2024-06-12实施公告](https://www.moutaichina.com/mtgf/attachDir/2024/06/2024061210531834730.pdf)：6月18日登记、6月19日除息及发放，每股CNY30.876，纯现金且非差异化。split-only P、V、实际turnover不随现金分红机械改变。
- [宁德时代2023-04-18实施公告](https://static.cninfo.com.cn/finalpage/2023-04-18/1216457838.PDF)：4月25日登记、4月26日10转8派25.20，股份比例1.8。确认原始股数单位后 P÷1.8、V×1.8，现金CNY2.52/旧股不得混入split比率。旧分钟历史可能超出供应商留存，不能声称已完成跨周期实测。
- [中际旭创2024-05-30实施公告](https://static.cninfo.com.cn/finalpage/2024-05-30/1220213405.PDF)：6月6日每10转4派4.50，但回购专户16,465,985股不参与，官方参考公式采用现金0.4408015、转增0.3918236。参与股份1.4与全股本参考系数1.3918236不是同一含义；当前不自动支持此类差异化事件，审核不足时保持UNKNOWN。

报价插件的日/分钟结果只能是调查线索。观察到241/49根中国分钟/5分钟记录（例如额外15:00收盘集合竞价）不能先验当作缺口或凭240/48强行裁掉；美国390/78根齐全也不证明其OHLC/量等于日线。实际SDK端点的单位、时间锚点、竞价/成交类型范围必须独立验证，再决定是否符合本系统会话契约，不能绕过门控。
