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

SQLite 使用 WAL、`synchronous=FULL`、`BEGIN IMMEDIATE` 和事件唯一约束。事件保存冻结输入与哈希；前端重连可重复投递，按事件 ID 合并。资金变更和计划修改使用 generation/version 校验，旧表单返回 409。

服务启动会校验 SQLite 实际版本、取得单实例锁并事务迁移数据库。支撑家族、容差和输入版本由服务端冻结；提醒页可只读重放原始判断、查看实际交易偏离及反馈修订历史。日线采样默认关闭，显式启用配置和隔离范围见操作说明。

候选页支持单个或 CSV 批量加入人工观察列表，原子校验最多 100 只研究标的；标签和笔记用版本校验防止并发覆盖。设置页可确认并保存 ADV、ADR 和每市场排名上限的新规则版本，旧计划与回放保留原依据。人工身份与筛选结论分开展示；数据截止、缺失原因、成交额来源和供应商配额未知状态均可查看。

## 行情探针

使用应用自己的只读 OpenAPI 凭据，不能复用聊天插件授权。配置 `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN` 后，明确传入 1–2 只已授权证券：

```bash
npm run probe -- --symbols AAPL.US --observe-seconds 30
```

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
- [私有部署与备份恢复](docs/operations.md)

Linear 项目：<https://linear.app/kejunz/project/pullback-lab-回调交易研究-018616dd62c7>。
