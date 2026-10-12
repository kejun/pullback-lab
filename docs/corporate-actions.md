# 公司行动证据导入与历史口径

此入口推进 KEJ-48。它保存人工核对的拆股、现金分红和覆盖范围资料，供仅拆股调整及历史审计使用。它不下载资料，不推断拆股比例，也不修改研究池中的日线、分钟线或行情能力。

`COMPLETE` 表示操作人员声明所选证券在给定窗口内的公司行动资料完整。程序检查结构、时间、引用和内容哈希；程序不能认证该声明，也不能凭一个公告证明整个窗口没有其他公司行动。无法证明完整时使用 `UNKNOWN`。两市场的真实行情能力仍为 UNKNOWN。

## 操作步骤

1. 用发行人、交易所或已验收数据供应商的资料核对证券、拆股比例、生效时刻和修订发布时间。另需取得完整覆盖窗口的依据。资料必须允许本地保存。
2. 准备下述 JSON 清单。首次导入使用 `expectedVersion: null`；后续清单携带当前版本。所有时刻为 UTC 毫秒，不能用本地时间字符串。覆盖终点不得晚于导入时刻。
3. 先运行预览。预览打开现有数据库的只读连接，不创建数据库、不迁移、不暂停计划。
4. 核对完整清单后停止应用，使用 `--apply` 写入。应用仍运行时会返回 `SERVICE_ALREADY_RUNNING`。旧数据库迁移前先生成一致备份；备份失败即停止。
5. 保存返回的证据版本。重新启动应用后，重新核对被暂停计划；不会自动恢复或补发机会。

```bash
export PULLBACK_DB=/private/path/pullback.sqlite
npm run actions:import -- --current AAPL.US
npm run actions:import -- /private/path/actions.json
npm run actions:import -- /private/path/actions.json --apply
```

`--current` 参数是工作区已有的 instrumentId，不一定等于供应商 symbol。不存在证据时返回 `version: null`。预览要求数据库已经升级至当前结构；可先按正常部署步骤启动新版应用完成有备份保护的迁移，再预览。导入本身也支持在停止应用后进行迁移。

成功命令返回 JSON，包含状态、提交清单对应版本、当前版本、实际接收时刻、行动数量、撤回列表和覆盖状态。重复提交返回原回执，不刷新接收时间、不改变当前版本、不重复暂停。提交旧清单的重试仍返回旧回执，`currentVersion` 指向最新版本；用 `--current` 查看最新覆盖状态。所有结果均为 `liveEligible: false`。

## 清单格式

可运行的合成示例为 [actions-synthetic.json](examples/actions-synthetic.json)。它只用于已载入示例证券的演示数据库。来源使用 example.invalid，内容明确为合成材料，不可用于真实证券。

| 字段 | 含义与约束 |
| --- | --- |
| schema | 固定为 `pullback-lab-actions-v1` |
| instrumentId / market | 已存在的证券标识及 US/CN，必须与工作区一致 |
| expectedVersion | 首次为 null；后续为 `--current` 返回的完整版本。过期版本拒绝写入 |
| source | 本清单的明确资料来源；同一行动更换来源应增加行动修订号 |
| review | reviewer 记录人工审核者；confirmed 必须明确为 true |
| coverage | from/through 为完整覆盖窗口；status 为 COMPLETE 或 UNKNOWN；reason 说明依据或缺口；documentIds 引用对应材料 |
| actions | 完整快照，每项含稳定 id、正整数 revision、kind、生效时刻 effectiveAt、该修订发布时间 publishedAt、documentIds |
| 拆股比例 | SPLIT 必须同时提供十进制字符串 sharesAfter 和 sharesBefore。例：2:1 正向拆股填 2 和 1；1:10 反向拆股填 1 和 10 |
| 现金分红 | kind 为 CASH_DIVIDEND，不填写拆股比例；仅拆股计算不会改变其价格、股数或成交额 |
| removedActionIds | 从上一快照删除的行动 id，必须明确列出且与实际差异相同。历史版本与行动事实仍保留 |
| documents | 每项含 id、https 来源 URL、发布时间、UTF-8 原文 content 和其 SHA-256。保存文本或原始 JSON 文本，不接收 PDF/base64 文件 |

哈希计算针对 `content` 字符串解码后的 UTF-8 字节，包含原有换行。外层 JSON 的空格、缩进和键顺序不影响证据版本。来源材料必须早于或等于引用它的行动修订发布时间。每个行动都必须位于声明覆盖窗口内；同一清单不能有重复 id。

清单总输入上限为 4 MB；正文合计上限为 2 MB；最多 20 份材料、500 项行动。材料原文随不可变快照保存在 SQLite 中，参与现有备份和恢复，不依赖外部临时文件。命令输出不包含原文、审核者或私有文件路径。来源 URL 与文本可能包含私有信息，数据库及备份应按现有私有部署方式保存。

## 修订、暂停与历史读取

写入采用 BEGIN IMMEDIATE，并在事务内核对 expectedVersion、行动最高修订号和撤回清单。相同 id/revision 的事实内容不能改变，也不能退回较低修订；修订和撤回只增加新快照。数据库触发器禁止 UPDATE、DELETE 和 REPLACE 覆盖证据。SQL 写入权限本身仍属于本机操作人员的信任边界。

系统接收时刻由导入进程写入，不接受清单指定；发布时间不等于系统当时已经知道。导入新证据后，同证券 WAIT_RETEST / ARMED 计划进入 DATA_PAUSED；事件保存新证据版本，旧计划版本、旧决策输入和原有资金占用不变。已交易待核对占用仍须由新资金快照核对。证据保存或暂停事件失败时，整个事务回滚。

`ActionEvidenceRepository.dataset(instrumentId, asOf)` 返回当时最新的完整快照。最新快照若为 UNKNOWN、窗口不足或缺证据，计算失败，不回退到更旧的 COMPLETE 快照。`adjust(instrumentId, bars, asOf, basisAt)` 只处理未复权、最终状态且在截止时刻已知的原始 K 线；调用方仍负责按证券和行情输入序号取出正确量价。

历史决策必须冻结 `coverage.version`、行情输入序号、asOf 和 basisAt。审计时将冻结证据版本传入 dataset/adjust 的最后一个参数，避免同一毫秒内多个导入版本的歧义。指定版本晚于 asOf 或不属于该证券时拒绝读取。当前行情计算不能用指定旧版本来绕过最新 UNKNOWN 状态。

调整输出版本前缀为 `split-only-v2`，与本批规范化哈希和校验语义对应。价格除以拆股比，股数乘以拆股比；原始量价及实际成交额保留。未来修订不进入过去回放。异常 OHLC、负量、非数值、非法时间和过大累计因子会返回失败原因，不返回部分调整结果。

## 工作台中的只读核验

进入「标的与计划」，在研究依据下方展开「公司行动证据」。未展开时不读取证据；切换证券、收起面板或重新读取会取消旧请求。页面可区分空记录、完整覆盖声明、覆盖待核验、读取失败和历史收录。

每次读取最多列出 20 个收录版本，按系统收录顺序倒序排列；同毫秒导入仍可区分。使用「读取更早版本」继续分页，使用「重新读取证据」查看此后新增的版本。选择历史记录只是查阅，不会把图表、资金、计划或筛选切换到旧证据。

版本详情显示来源、人工核验者、覆盖依据、公司行动生效/发布时间和引用材料。比较固定使用所选版本的前一个已收录版本，列出来源、覆盖、核验者、行动与材料的新增、修订或移除。记录移除不等于删除历史；查看旧版本仍能读取原来的材料。

资料正文通过「查看原文」单独读取，并以纯文本显示。来源地址在新标签页打开；页面不会自动访问来源或执行正文 HTML。SHA-256 用于核对文本一致性，不能证明资料真实。已有公司行动证据的证券不能移出观察列表；可以继续修改标签和观察笔记。

只读接口沿用应用登录鉴权，响应为 `Cache-Control: no-store`：

| GET 路径 | 返回内容 |
| --- | --- |
| `/api/instruments/:id/action-evidence?before=SEQUENCE` | 固定 20 条版本概要及 `nextBefore`；首次省略 before；不含正文 |
| `/api/instruments/:id/action-evidence/:version` | 所选版本详情、读取时的当前版本与前一收录差异；不含正文 |
| `/api/instruments/:id/action-evidence/:version/documents/:documentId` | 指定版本的原文与摘要；版本和材料均须属于该证券 |

所有标识需作为独立 URL 路径段编码；非法分页返回 400，未知或不属于该证券的版本/材料返回 404。移出已有证据的证券返回 409 `INSTRUMENT_HAS_ACTION_EVIDENCE`，保留原证券与不可变历史。没有网页导入接口；导入仍使用上述维护命令。

## 尚未完成

本批没有导入真实公司行动，也没有核验任何发行人公告。人工 COMPLETE 声明不等于供应商权限、交易日历、最终 K 线或数据连续性已经通过。正式筛选和计划所需的真实量价接入、跨日价格尺度核对及目标会话公司行动变化检测仍待接入；此入口不会自动将隔离行情提升为可用行情。KEJ-48 保持进行中。
