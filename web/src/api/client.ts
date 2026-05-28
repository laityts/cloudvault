/** HTTP error preserves status + parsed body for callers that care. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** If true, treat 401 as a transient error and don't auto-redirect to /login. */
  noAuthRedirect?: boolean;
}

/** Core fetch wrapper: same-origin credentials, JSON body shorthand,
 *  401 → /login redirect (unless suppressed). */
export async function apiFetch<T = unknown>(input: string, opts: RequestOptions = {}): Promise<T> {
  const { body, noAuthRedirect, headers, ...rest } = opts;

  const init: RequestInit = {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(body !== undefined && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof ArrayBuffer)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...headers,
    },
  };

  if (body !== undefined) {
    if (body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || typeof body === 'string') {
      init.body = body as BodyInit;
    } else {
      init.body = JSON.stringify(body);
    }
  }

  const res = await fetch(input, init);

  if (res.status === 401 && !noAuthRedirect) {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError(401, null, 'Unauthorized');
  }

  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.clone().json();
    } catch {
      try {
        errBody = await res.text();
      } catch {
        /* ignore */
      }
    }
    const message =
      errBody && typeof errBody === 'object' && 'error' in errBody && typeof (errBody as any).error === 'string'
        ? (errBody as any).error
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, errBody, message);
  }

  if (res.status === 204) return undefined as T;

  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}
