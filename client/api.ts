export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const apiBase = /^\/admin(?:\/|$)/.test(window.location.pathname)
  ? "/admin/api"
  : "/api";

export const READ_TIMEOUT_MS = 10_000;
type RequestOptions = RequestInit & { timeoutMs?: number };

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { timeoutMs = READ_TIMEOUT_MS, ...init } = options;
  const reading = ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  const timeout = reading ? AbortSignal.timeout(Math.max(0, Math.ceil(timeoutMs))) : null;
  const signal = timeout
    ? init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    : init.signal;
  try {
    const response = await fetch(`${apiBase}${path}`, {
      credentials: "same-origin",
      ...init,
      signal,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    signal?.throwIfAborted();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `The server returned an unexpected response (${response.status}).`,
      );
    }
    if (!response.ok) {
      const error = data as { error?: string };
      throw new ApiError(error.error || `Request failed (${response.status}).`, response.status);
    }
    return data as T;
  } catch (error) {
    if (timeout?.aborted && !init.signal?.aborted)
      throw new Error("Loading took too long. Please try again.");
    throw error;
  }
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
