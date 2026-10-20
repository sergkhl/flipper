export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const apiBase = /^\/admin(?:\/|$)/.test(window.location.pathname)
  ? "/admin/api"
  : "/api";

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
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
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
