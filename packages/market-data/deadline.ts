/** A deadline bounds our wait; it does not claim to cancel a native SDK request. */
export class OperationTimeout extends Error {
  constructor() {
    super("OPERATION_TIMEOUT");
  }
}
export class OperationAborted extends Error {
  constructor() {
    super("OPERATION_ABORTED");
  }
}
export function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    return Promise.reject(new Error("INVALID_DEADLINE"));
  if (signal?.aborted) return Promise.reject(new OperationAborted());
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new OperationAborted());
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new OperationTimeout());
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    // Attach both handlers even after a timeout, so late rejections are consumed.
    try {
      operation().then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
