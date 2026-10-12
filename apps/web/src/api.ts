export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal: options?.signal,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Requested-With": "PullbackLab",
      ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({
    error: "服务器暂时无法响应，请稍后重试。",
    code: "INVALID_RESPONSE",
  }));
  if (!response.ok)
    throw new ApiError(
      data.error || "请求未完成",
      response.status,
      data.code || "REQUEST_FAILED",
    );
  return data as T;
}
