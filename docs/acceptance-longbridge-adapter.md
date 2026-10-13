# 验收：Longbridge 同路径运输与可信日线消费

基线 main：`9c56470fc2794515177bff8acee277cea27d7e67`（PR15）。本批不修改触发公式、风险默认值、资金事务或交易能力。

- KEJ-46/47/38：实现 QuoteContext-only 生产 adapter 和 createApp server factory，已审计 context/限额为前置条件；实际 SDK-shaped 回调进入原不可变回执、标准化与闭合运行器。
- KEJ-48/39：精确 server context 日线进入候选和AVWAP，原参数确认、人工身份、split-only要求保留；过期使缓存失效；未知数据保持 UNKNOWN。
- 实际账户授权、目标地区、证券规则/量价单位/日历/历史最终状态/拆股覆盖和真实网络可靠性仍未验收，整体 issue 保持进行中。无真实行情调用、无凭据配置、无上线或交易。

核心验证入口 `apps/server/tests/longbridge-closed-bar-adapter.test.ts` 覆盖标准 SDK 调用参数、回补历史隔离、真实回调接线、单位与时间拒绝、unsafe整数、停牌/错误/超时/过期、旧回调屏蔽、迟到订阅清理、限额低值与月持久账本、服务器工厂与鉴权图表、缓存到期及真实回执链。所有输入均是明确标记的隔离测试资料，不代表真实证券能力。

完整类型检查、测试、构建、浏览器和准确 head CI 的最终数量/提交/tree映射记录在 PR。真实验收清单及官方来源见 [Longbridge 接线说明](longbridge-closed-adapter.md)。
