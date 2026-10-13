# Pullback Lab 回调交易研究

面向个人研究的候选筛选、回踩计划、风险核算和判断记录工具。当前交付研究工作台与明确标记的合成回放。**真实行情监测尚未开放**：OpenAPI 权限、实际部署地区、拆股来源与连续逐笔证据仍待核验。

应用不会访问交易账户或提交订单。人工资金快照不能替代实际账户余额；止损参考也不是最大损失保证。

## 本地运行

需要 Node.js 24 和 npm。依赖版本锁定在 `package-lock.json`。

```bash
npm ci
export PULLBACK_PASSWORD='replace-with-a-long-private-password'
export PULLBACK_DEMO=1
npm run dev
```

打开 <http://127.0.0.1:5173>，输入访问密码。默认数据库为 `data/pullback.sqlite`。真实空白研究环境不设置 `PULLBACK_DEMO`。

演示流程：打开设置 → 载入合成示例数据 → 填入并确认合成资金 → 确认筛选预设 → 选择 `DEMO-A.US` → 填入合成示例计划并确认研究背景 → 保存 → 检查风险 → 启用合成计划观察 → 运行合成回放 → 在提醒与记录中填写反馈。也可在启用观察后选择「准备分步合成演练」，逐条推进并查看持久进度；一次尝试只能选择一种回放方式。固定样本的交易日为 `2026-10-09`，其结果始终是历史合成事件。

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

已安装独立 Chromium 时，可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定可执行文件。生产构建后执行 `npm start`，由同一个服务提供页面和 API。

## 实现结构

| 路径                   | 职责                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `packages/domain`      | 十进制指标、筛选、支撑容差、风险求解、纯函数触发状态机               |
| `packages/market-data` | 只读行情适配、交易日历、量价规范化、不可变修订、拆股、能力和配额门控 |
| `packages/contracts`   | 前后端数据类型；价格用字符串，事件时间用 UTC 毫秒，图表时间用 UTC 秒 |
| `apps/server`          | Fastify API、SQLite 事务、认证、计划版本、资金预留、事件与反馈       |
| `apps/web`             | React 三页工作台、Lightweight Charts 图表、SSE 提醒                  |
| `tests/e2e`            | 浏览器中的研究、回放和反馈闭环                                       |

正式收盘运行链已经具备服务端适配器边界、持久分钟/尝试、真实时钟截止、资金复核与事务事件。现已提供受已审计服务器上下文门控的Longbridge SDK适配器及日线研究消费接线；默认生产启动不安装适配器，真实行情继续关闭；不会把人工历史或采样回执升级为行动信号。见[正式收盘运行契约](docs/closed-bar-runtime.md)及[Longbridge 接入验收清单](docs/longbridge-closed-adapter.md)。

SQLite 使用 WAL、`synchronous=FULL`、`BEGIN IMMEDIATE` 和事件唯一约束。事件保存冻结输入与哈希；前端重连可重复投递，按事件 ID 合并。资金变更使用 generation 校验，计划操作同时校验 version 与 attemptId；旧表单或旧标签页返回 409 并保留输入。

服务启动会校验 SQLite 实际版本、取得单实例锁并事务迁移数据库。支撑家族、容差和输入版本由服务端冻结；提醒页可只读重放原始判断、查看实际交易偏离及反馈修订历史。行情采样默认关闭。可额外选择最多十只已有研究标的采集 1/5 分钟历史；各周期独立记录进度、空结果和失败，分钟样本保持隔离。配置见[分钟历史采样](docs/minute-sampling.md)。

候选页支持单个或 CSV 批量加入人工观察列表，原子校验最多 100 只研究标的；标签和笔记用版本校验防止并发覆盖。设置页可确认并保存 ADV、ADR 和每市场排名上限的新规则版本，旧计划与回放保留原依据。人工身份与筛选结论分开展示；数据截止、缺失原因、成交额来源和供应商配额未知状态均可查看。

设置页可读取并下载脱敏运行报告。生产启动先检查密码、HTTPS 来源及前端构建，旧数据库迁移前自动备份；`npm run backup` 生成一致快照，`npm run restore -- BACKUP_PATH NEW_DATABASE_PATH` 恢复到新文件并失效旧会话、资金确认与旧命令。单主机 Compose 与 Caddy 配置见部署说明。

暂停或重启后的分步演练可显式选择「新建恢复尝试」，从已保存进度之后继续。恢复使用新身份，需重新高于支撑区上沿后再回踩；保存新计划版本也不会重新冒充会话首次。已消费尝试不通过恢复重复入场。已交易待核对占用不会被编辑或暂停释放，须在资金面板确认已反映实际交易的新快照。

## 行情探针

使用应用自己的只读 OpenAPI 凭据，不能复用聊天插件授权。配置 `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN` 后，明确传入 1–2 只已授权证券：

```bash
npm run probe -- --symbols AAPL.US --observe-seconds 30 --output probe-evidence.jsonl
```

探针按证券分别采集日线、1/5 分钟、报价、静态资料与日历，并独立记录行情等级、套餐和可选的闭合推送。`--output` 创建新的私有 JSONL 文件，每一步追加并同步证据；不会覆盖旧报告。标准输出为最终 JSON。普通失败保留此前结果并继续独立步骤；请求超时后停止后续调用，避免堆积未结束请求。

探针只使用 QuoteContext，不购买行情。退出码 `2` 表示能力仍未完成验证，`1` 表示探针失败。采样成功也不会自动开放实时提醒。SDK 5.2.0 的逐笔推送类型未提供包级序号，本地排序不能证明无丢包。

## 需求与交付

- [需求 v0.2](docs/requirements-v0.2.md)
- [技术方案 v1.0](docs/technical-plan-v1.0.md)
- [工程口径 C01–C07](docs/engineering-spec.md)
- [接口契约](docs/api-contract.md)
- [验收与未完成范围](docs/acceptance.md)
- [第二批实现与验证](docs/acceptance-v2.md)
- [第三批实现与验证](docs/acceptance-v3.md)
- [第四批实现与验证](docs/acceptance-v4.md)
- [第五批实现与验证](docs/acceptance-v5.md)
- [第六批实现与验证](docs/acceptance-v6.md)
- [第七批实现与验证](docs/acceptance-v7.md)
- [第八批实现与验证](docs/acceptance-v8.md)
- [第九批实现与验证](docs/acceptance-v9.md)
- [第十批实现与验证](docs/acceptance-v10.md)
- [第十一批实现与验证](docs/acceptance-v11.md)
- [第十二批实现与验证](docs/acceptance-v12.md)
- [单主机私有部署](docs/deployment.md)
- [私有部署与备份恢复](docs/operations.md)

Linear 项目：<https://linear.app/kejunz/project/pullback-lab-回调交易研究-018616dd62c7>。

## 公司行动证据

`npm run actions:import -- MANIFEST.json` 预览人工核对的公司行动清单；停止应用后加 `--apply` 写入。导入保存不可变来源文本、覆盖范围、修订及系统接收时间，并原子暂停受影响计划。`--current INSTRUMENT_ID` 可读取当前证据版本。真实行情仍未开放；操作步骤、信任边界与合成示例见 [公司行动证据导入](docs/corporate-actions.md) 和 [第八批验收](docs/acceptance-v8.md)。

研究页的「公司行动证据」面板可只读查看覆盖声明、来源原文和收录历史，并与前一版本比较。原文按需读取，历史查阅不改变图表或计划；已有证据的证券不可移出观察列表。页面能力与验收见 [第九批验收](docs/acceptance-v9.md)。

`npm run --silent basis:audit -- REQUEST.json` 可只读核验已入库的日线、1 分钟和 5 分钟样本是否共享已收盘目标会话的拆股尺度。报告固定证据版本、接收水位与输入指纹；通过只表示所选窗口数值一致，不开放真实行情。准备输入、退出码与范围见 [价格尺度审计](docs/price-basis-audit.md)。

设置页可按周期查看已保存的采样回执、校验哈希、对比同根前序并下载当前报告。旧版请求周期明确保留未知。查看不会放行隔离行情，操作及限制见 [采样回执核验](docs/provider-receipts.md)。

研究页现在可下载模板、预览并明确导入人工历史资料，直接查看统一拆股尺度的日线/分钟图，选择锚点和保存固定资料版本的计划草稿。导入时间真实保留，分钟 AVWAP 明确标为事后历史重建；人工资料不开放真实提醒。格式与边界见[人工历史资料](docs/research-history.md)和[第十三批验收](docs/acceptance-v13.md)。

生产行情装配、逐日历史覆盖校验与安全 probe 摘要命令见 [docs/production-market.md](docs/production-market.md)。默认关闭，`market:check` 不访问供应商。

完整日期窗口的私有行情采集及独立 US/CN 日线研究见 [有界历史采集](docs/bounded-history.md) 与 [EOD 研究接线](docs/eod-research.md)。研究资格不代替实时监测资格；默认配置仍关闭。
