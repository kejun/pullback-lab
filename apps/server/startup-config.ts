import { statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { RuntimeSafetyError } from "./runtime-safety.js";

export interface StartupConfig {
  databasePath: string;
  backupDirectory: string;
  staticRoot: string;
  password: string;
  host: string;
  port: number;
  origin?: string;
  production: boolean;
  demo: boolean;
  restore: boolean;
}

function invalid(code: string, message: string): never {
  throw new RuntimeSafetyError(code, message);
}
function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  if (value !== undefined && value !== "0" && value !== "1")
    invalid("INVALID_STARTUP_FLAG", "启动开关只接受 0 或 1");
  return value === "1";
}

/** Read-only preflight: reject configuration before a lock, migration or recovery can write. */
export function readStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): StartupConfig {
  const production = env.NODE_ENV === "production";
  const password = env.PULLBACK_PASSWORD;
  if (!password || password.trim().length < 8)
    invalid("PASSWORD_NOT_CONFIGURED", "请配置至少 8 位的访问密码后启动");
  let origin: string | undefined;
  if (env.PULLBACK_ORIGIN !== undefined) {
    try {
      const url = new URL(env.PULLBACK_ORIGIN);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (production && url.protocol !== "https:")
      )
        throw new Error("Invalid origin");
      origin = url.origin;
    } catch {
      invalid(
        "INVALID_PUBLIC_ORIGIN",
        "访问来源须为完整来源地址，生产环境须使用 HTTPS",
      );
    }
  }
  if (production && !origin)
    invalid("HTTPS_ORIGIN_REQUIRED", "生产环境必须配置 HTTPS 访问来源");
  const portText = env.PORT ?? "3000";
  const port = Number(portText);
  if (
    !/^\d{1,5}$/.test(portText) ||
    !Number.isInteger(port) ||
    port < (production ? 1 : 0) ||
    port > 65535
  )
    invalid("INVALID_PORT", "服务端口配置无效");
  const host = env.HOST ?? "127.0.0.1";
  const hostname =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
  if (!isIP(host) && (host.length > 253 || !hostname.test(host)))
    invalid("INVALID_HOST", "监听地址配置无效");
  const database = env.PULLBACK_DB ?? "data/pullback.sqlite";
  const backup = env.PULLBACK_BACKUP_DIR;
  if (
    !database.trim() ||
    database === ":memory:" ||
    database.startsWith("file:") ||
    (backup !== undefined && (!backup.trim() || backup.startsWith("file:")))
  )
    invalid("INVALID_DATABASE_PATH", "服务需要有效的本地数据库及备份目录");
  const databasePath = resolve(cwd, database);
  const staticRoot = resolve(cwd, "dist/web");
  if (
    production &&
    !statSync(resolve(staticRoot, "index.html"), {
      throwIfNoEntry: false,
    })?.isFile()
  )
    invalid("WEB_BUILD_REQUIRED", "生产页面尚未构建，请先执行 npm run build");
  flag(env, "PULLBACK_MARKET_WORKER");
  return {
    databasePath,
    backupDirectory: backup
      ? resolve(cwd, backup)
      : resolve(dirname(databasePath), "backups"),
    staticRoot,
    password,
    host,
    port,
    origin,
    production,
    demo: flag(env, "PULLBACK_DEMO"),
    restore: flag(env, "PULLBACK_RESTORED"),
  };
}
