# 跨周期价格尺度审计

此命令检查已入库的原始日线、1 分钟和 5 分钟样本能否使用同一份公司行动证据，换算到一个**已经收盘的目标会话**。它是只读的历史核验步骤，不写入正式图表、指标、计划、资金或提醒。

`CONSISTENT` 只表示选定窗口的数值与尺度一致。它不证明行情来源真实、交易日历权威、公司行动完整、整个交易日连续或实时提醒可用。报告固定输出 `scope=SELECTED_WINDOWS`、`liveEligible=false`。未来或尚未收盘的目标会话返回 `UNKNOWN`；本步骤不能证明未来目标会话的尺度。

## 准备输入

1. 使用正常应用升级流程迁移到数据库结构 v7。v7 只增加按行情身份与接收序号查询的索引，旧记录不变。正常启动仍先备份旧库，备份失败则停止升级。审计遇到旧库会退出，不会自行创建、迁移或修复数据库。
2. 按 `docs/corporate-actions.md` 导入经核对的公司行动证据。覆盖窗口须从所选最早日线开始，至少到目标会话收盘。`COMPLETE` 是人工声明，不是自动认证。
3. 取得已接受的 `market_raw_inputs.ingest_sequence`、公司行动 `version` 和行情接收水位。当前生产 worker 只隔离采样；本命令不把隔离资料提升为已验证分钟数据，也不新增导入行情的后门。没有合格的日线和分钟输入时，正式审计仍需等待接入工作。
4. 准备请求 JSON。`calendarDays` 必须包含每根所选日线与目标会话的实际日历依据，包含交易所当地日期、常规时段、来源、版本、资料可知时间。美股时区由现有日历模块处理；A 股午休必须显式列出。不得用工作日推算开市日期。

维护时可用 SQLite 客户端只读查询元数据。例如，替换下列合成证券 ID；查询不会导入或授权任何资料：

```sql
BEGIN;
SELECT MAX(ingest_sequence) AS receiptWatermark FROM market_raw_inputs;
SELECT version, recorded_at FROM corporate_action_snapshots
WHERE instrument_id = 'DEMO-US-A' ORDER BY sequence DESC LIMIT 1;
SELECT ingest_sequence, received_at, status,
       json_extract(payload_json, '$.period') AS period,
       json_extract(payload_json, '$.sessionId') AS sessionId,
       json_extract(payload_json, '$.start') AS start,
       json_extract(payload_json, '$.end') AS end
FROM market_raw_inputs
WHERE json_extract(payload_json, '$.instrumentId') = 'DEMO-US-A'
  AND status IN ('INSERTED', 'REVISION')
ORDER BY ingest_sequence DESC LIMIT 200;
COMMIT;
```

历史核验应选择在 `asOf` 前已收到的证据和行情。下面是字段模板；全零证据版本和序号是占位值，不能直接当作真实审计依据。

```json
{
  "schema": "pullback-lab-price-basis-audit-v1",
  "instrumentId": "DEMO-US-A",
  "market": "US",
  "asOf": 1791590400000,
  "evidenceVersion": "action-evidence-v1:0000000000000000000000000000000000000000000000000000000000000000",
  "receiptWatermark": 7,
  "sequences": [1, 2, 3, 4, 5, 6, 7],
  "targetDate": "2026-10-09",
  "calendarDays": [
    {
      "market": "US", "date": "2026-10-08", "status": "OPEN",
      "intervals": [{"open": "09:30", "close": "16:00"}],
      "source": "synthetic-calendar", "version": "fixture-v1",
      "knownAt": 1790812800000, "verified": true
    },
    {
      "market": "US", "date": "2026-10-09", "status": "OPEN",
      "intervals": [{"open": "09:30", "close": "16:00"}],
      "source": "synthetic-calendar", "version": "fixture-v1",
      "knownAt": 1790812800000, "verified": true
    }
  ]
}
```

`sequences` 至少包含一根目标会话之前的日线、同一目标会话连续五根 1 分钟线和一根对应的 5 分钟线。可提交多组完整窗口，但不能重复同周期窗口，也不能混入不同证券、来源或真实/合成身份。原生 5 分钟资料是否独立来自供应商，仍须另行核对来源，本报告不认证其独立性。

## 执行与读取报告

设置 `PULLBACK_DB` 指向现有数据库，然后运行：

```bash
npm run --silent basis:audit -- private-basis-request.json
```

标准输出为 JSON。退出码 `0` 表示 `CONSISTENT`，`2` 表示证据不足或不一致的 `UNKNOWN`，`1` 表示输入、数据库结构或执行失败。可以在服务持有运行锁时读取。命令不联网、不要求行情凭据，不提供写入选项。请求上限 2 MB，最多 10,000 个行情引用和 1,000 条日历资料；不接受符号链接或管道输入。

报告包含完整请求、输入指纹、算法版本、固定公司行动版本、目标会话、统一复权版本、原始与调整后的价量、换算因子及比较窗口数。后来的修订不进入固定水位；`currentEvidenceVersion` 与 `evidenceIsCurrent` 单独说明读取时是否已经有更新的公司行动资料。这两个当前状态字段可以变化，不参与历史输入指纹。

一个窗口中，1 分钟聚合的 OHLC、股数与实际成交额必须与所选 5 分钟线精确相等。不使用浮点容差掩盖单位或口径差异。缺分钟、缺成交额、修订冲突或数据不一致均不输出部分可用结果。日线价格按拆股比例调整，股数反向调整，实际成交额保留；现金分红不机械改变股数。

若拆股发生在历史单根 K 线内部，则无法用单一因子解释整根 OHLC。若拆股发生在目标会话开盘之后至收盘之间，则目标分钟价格不再共享一个原始尺度。这两种情况都返回 `UNKNOWN`。目标开盘时生效的拆股可以调整此前日线，同时保持目标分钟价格不变。

请求文件和报告包含研究标的、行情样本与资料来源，应作为私有研究资料保存。失败响应只显示稳定错误码，不回显请求内容或本地路径。
