# 私有部署与恢复

当前支持一个 Node.js 进程和一个本地 SQLite 数据库。实时行情入口尚未接通，部署研究工作台不会改变数据能力状态。

## 配置

| 环境变量              | 用途                                                          |
| --------------------- | ------------------------------------------------------------- |
| `PULLBACK_PASSWORD`   | 至少 8 位的访问密码；建议使用随机长密码                       |
| `PULLBACK_DB`         | 数据库路径，默认 `data/pullback.sqlite`                       |
| `HOST` / `PORT`       | 默认 `127.0.0.1:3000`                                         |
| `PULLBACK_ORIGIN`     | HTTPS 反向代理的完整来源，例如 `https://research.example.com` |
| `NODE_ENV=production` | 开启 Secure 会话 Cookie，必须通过 HTTPS 访问                  |
| `PULLBACK_DEMO=1`     | 显式开放合成样本与历史回放，默认关闭                          |
| `PULLBACK_RESTORED=1` | 恢复备份后首次启动，废止旧会话和资金确认；完成后移除          |

构建后运行 `npm start`。`GET /api/health` 提供服务健康状态，`dataReady:false` 明确表示真实监测尚未验收。公网部署应由 HTTPS 代理提供 TLS，代理保持 `/api/events/stream` 不缓冲；应用端口只对代理可见。不要直接暴露无 TLS 的服务端口。

仓库提供 Dockerfile，但部署目标、域名、TLS、持久卷和真实主机恢复演练需要在选定环境中验收，不能由本地构建替代。

```bash
docker build -t pullback-lab .
docker volume create pullback-data
docker run --rm --name pullback-lab \
  --env-file /absolute/private/path/pullback.env \
  -p 127.0.0.1:3000:3000 \
  -v pullback-data:/app/data pullback-lab
```

私有环境文件仅存主机，不纳入 Git。生产密码轮换会使旧会话失效。程序日志不输出密码或行情凭据。

## 在线备份

使用 SQLite Online Backup API 获取一致快照，不直接复制一个正在写入的 `.sqlite` 主文件。备份目标必须是尚不存在的路径。

```bash
PULLBACK_DB=data/pullback.sqlite npm run backup -- /absolute/private/path/backup-2026-10-12.sqlite
```

脚本在备份后执行 `PRAGMA integrity_check`。备份包含人工资金和研究记录，应使用与主数据库相同的访问权限，保留在独立持久介质。账户密码环境文件和行情密钥不在数据库备份中。

## 恢复顺序

1. 停止全部访问该数据库的应用进程，保留原数据目录作为故障排查副本。
2. 检查备份完整性，复制到一个新的空数据目录。不要把新主库文件与旧 `-wal`、`-shm` 文件混用。
3. 将 `PULLBACK_DB` 指向恢复后的文件，并设置 `PULLBACK_RESTORED=1` 启动一次。
4. 重新登录并核对计划、记录和预留。资金快照需要重新确认。未完成观察必须建立新的尝试和数据证据，不能补发旧实时提醒。
5. 停止服务，移除 `PULLBACK_RESTORED`，再正常启动。每次进程重启仍需要安全恢复检查。

已触发但尚未反馈的事件会保留其占用，不能因重启或时间到期自动释放。填写“已交易”会使资金快照过期，用户须以已反映该交易的余额重新确认；“已跳过”只能释放一次。恢复后的历史事实和反馈修订保留，不伪装为新的实时事件。
