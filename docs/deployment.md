# 单主机私有部署

部署包将一个 Node.js 应用实例、一个本地 SQLite 持久卷与 Caddy HTTPS 代理放在同一台主机。只有 Caddy 发布 80/443 端口，应用的 3000 端口留在容器网络内。默认关闭合成演示和行情采样。

这份配置可以用于目标主机验收。域名、证书签发、主机重启及异地恢复仍须在实际环境中验证；镜像构建和进程健康检查不表示真实行情已通过验收。

## 准备主机

- 使用具有本地磁盘的 Docker Engine 主机，以及 Docker Compose 2.30.0 或更新版本。不要把 SQLite 卷放在 NFS、SMB 等网络文件系统上。
- 为研究应用准备一个域名，确认 A/AAAA 指向该主机。Caddy 的标准自动证书配置需要主机对外开放 TCP 80/443；UDP 443 用于 HTTP/3。
- 保留 Caddy 的 `/data` 与 `/config` 卷，以便容器重建后保留证书与配置。数据卷与日志需要足够的磁盘空间。
- 只运行一套应用。Compose 使用固定容器名阻止横向扩容，应用还会通过数据库进程锁拒绝第二个服务实例。

以下命令均从仓库根目录运行。先检出已经通过 CI 的提交，记录提交号与构建后的镜像 ID。

## 配置与启动

```bash
docker compose version
umask 077
test ! -e deploy/pullback.env && install -m 600 deploy/pullback.env.example deploy/pullback.env
```

在主机上编辑 `deploy/pullback.env`，填入新生成的随机长密码，至少 8 位。示例中的密码为空，不能直接启动。文件使用 `KEY=value` 原始格式：不要加引号、行尾注释或 shell 命令；`$` 保留为密码本身的字符。密码和行情凭据只存于主机私有文件，不能提交到 Git 或放入构建参数。只有应用容器读取该文件，Caddy 不接收这些秘密。

在当前终端设置公开来源并定义命令简写：

```bash
export PULLBACK_ORIGIN=https://research.example.com
dc() { docker compose --env-file /dev/null -f deploy/compose.yml "$@"; }
dc config --quiet
dc build app
docker image inspect pullback-lab:local --format '{{.Id}}'
```

将示例域名替换为真实域名。`PULLBACK_ORIGIN` 必须是完整 HTTPS 来源，不包含路径、查询参数或末尾 `/`。Compose 将相同值传给应用和 Caddy，避免写请求来源与代理地址不一致。每次新开管理终端都要恢复这一公开变量及 `dc` 定义。

`--env-file /dev/null` 阻止 Compose 自动读取工作目录中的其他 `.env` 文件；应用仍通过 `env_file` 读取 `deploy/pullback.env`。需要把秘密文件放在仓库外时，可以额外导出 `PULLBACK_ENV_FILE`，值为该文件的绝对路径。使用 `config --quiet`，不要把展开后的秘密配置复制进日志或工单。

先验证代理配置，再启动：

```bash
docker run --rm -e PULLBACK_ORIGIN \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --validate >/dev/null
dc up -d --wait --wait-timeout 120
dc ps
```

配置验证不会申请证书。启动后，Caddy 根据域名自动申请和续期证书，并把 HTTP 请求转到 HTTPS。生产启动预检会拒绝缺失或过短的密码、不合法的 HTTPS 来源，以及未构建的前端页面。

浏览器访问设置好的 HTTPS 地址，登录后检查设置中的运行状态。未登录者只能访问登录入口与基础健康信息，不能读取研究数据和运维详情。不要另加应用端口映射。若主机已有 80/443 代理，应先协调端口及代理归属，再运行这套配置。

## 健康、事件流与守护

Docker 健康检查只请求容器内部的 `/api/health`，要求 HTTP 成功且 `ok:true`。`dataReady:false` 是当前真实行情未验收的状态，不会把存活服务判为故障。Caddy 等应用首次健康后启动。进程退出由 `restart: unless-stopped` 恢复；单纯 `unhealthy` 状态不会由 Docker 自动重启，应检查原因后处理。

应用以非 root 用户运行，根文件系统只读；SQLite 所在的 `/app/data` 卷与临时目录可写。容器停止预留 30 秒，以便结束采样、关闭数据库并释放进程锁。日志采用大小与数量轮转。

Caddy 会即时发送 `Content-Type: text/event-stream` 响应。配置没有增加响应缓冲、压缩或固定事件流超时。上层 CDN 或另一层代理同样需要允许 SSE 长连接。实际验收时，在浏览器网络面板确认 `/api/events/stream` 持续接收心跳；断网恢复或应用重启后，应从持久游标续接。不能用普通首页请求成功代替事件流验收。

## 更新与密码轮换

升级前先完成一致备份并拷出主机。确认新提交的 CI 通过，再检出目标版本并执行：

```bash
dc build app
dc up -d --wait --wait-timeout 120 app
dc ps
```

数据库迁移在应用启动时运行，失败则拒绝启动并保留错误供检查。保留旧镜像、升级前备份和提交号；新版本数据库不能直接交给不兼容的旧程序。需要回退时，按恢复流程使用升级前的备份创建新的数据库文件。

轮换密码时编辑私有环境文件，再重建应用容器以加载新值：

```bash
chmod 600 deploy/pullback.env
dc up -d --force-recreate --wait --wait-timeout 120 app
```

旧登录会话会失效。单独 `dc restart app` 不会重新加载修改后的环境文件。

## 备份与恢复

在线备份通过 SQLite Backup API 生成一致快照。以下命令把备份写入数据卷，再拷到主机的私有备份目录：

```bash
backup_file="pullback-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
dc exec -T app npm run backup -- "/app/data/backups/$backup_file"
install -d -m 700 backups
dc cp "app:/app/data/backups/$backup_file" "backups/$backup_file"
chmod 600 "backups/$backup_file"
```

继续把该文件保存到独立持久介质。同一主机内的目录或同一个 Docker 卷不能替代异地备份。备份包含资金与研究记录；环境密码、行情密钥和 TLS 证书不在数据库备份中，须分别保管。

恢复必须先停止应用，使用 `npm run restore -- BACKUP_PATH NEW_DATABASE_PATH` 创建新的数据库文件，再让 Compose 指向该文件。新恢复命令已经废止旧会话、资金确认与未完成观察，不需要再设置 `PULLBACK_RESTORED=1`。执行步骤与恢复后的业务核对见[运维恢复说明](operations.md)。Compose 支持通过 shell 中的 `PULLBACK_DB` 改变路径，恢复文件应保留在 `/app/data` 持久卷内；记录该变量以供后续管理终端继续使用。不要删除原库和旧 WAL/SHM 进行覆盖恢复。

停机使用 `dc stop`。`dc down` 保留命名卷；不要在真实部署上使用 `down --volumes`，它会删除数据库和证书卷。

## 目标主机验收记录

部署验收至少记录提交号、镜像 ID、主机平台、域名、日期和结果：

| 检查           | 通过条件                                                                |
| -------------- | ----------------------------------------------------------------------- |
| HTTPS 与端口   | 证书有效；HTTP 转 HTTPS；主机没有发布应用的 3000 端口                   |
| 登录与来源     | 正确密码可登录；错误密码被拒；Cookie 带 Secure/HttpOnly；跨来源写入被拒 |
| 默认模式       | 合成演示关闭、行情采样关闭；真实能力仍显示未验收                        |
| 持久性         | 写入一条人工研究记录，重建应用容器后记录仍在                            |
| 守护与安全恢复 | 主机重启后服务恢复；资金须重确认，旧观察不自动续跑                      |
| SSE            | 心跳及时抵达；短暂断网后恢复；历史事件不重复提醒                        |
| 备份恢复       | 独立介质上的备份通过检查；恢复到新文件后旧会话失效，记录保留            |

当前开发环境没有 Docker/Caddy 可执行程序，因此本地仅能检查配置与文档。远端 CI 的镜像构建及容器烟测结果应单独记录；仍不能代替上述目标主机验收。

## 配置依据

- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)：`env_file.format: raw` 要求 Compose 2.30.0+；`environment` 覆盖秘密文件同名字段；`service_healthy` 控制启动依赖，`unless-stopped` 控制退出后的重启。
- [Docker HEALTHCHECK](https://docs.docker.com/reference/dockerfile/#healthcheck)：探测结果决定健康状态；本项目只以 HTTP 服务存活作为通过条件。
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)：命名卷独立于容器生命周期，用于本地数据库和证书持久化。
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)：公开域名、DNS、开放端口与可写持久数据目录是标准自动证书配置的前提。
- [Caddy reverse_proxy streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)：事件流响应按 SSE 类型即时刷新，无需新增缓冲或固定断线间隔。
