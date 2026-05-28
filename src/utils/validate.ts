import { AppError } from './handler';

export async function parseJson<T extends Record<string, unknown>>(
  request: Request,
  requiredFields: ReadonlyArray<keyof T & string> = [],
): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError('Invalid JSON body', 'INVALID_JSON', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be a JSON object', 'INVALID_BODY', 400);
  }
  const obj = body as Record<string, unknown>;
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new AppError(`Missing required field: ${field}`, 'MISSING_FIELD', 400);
    }
  }
  return obj as T;
}

export async function parsePassword(request: Request): Promise<string> {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    return (formData.get('password') as string) || '';
  }
  if (contentType.includes('application/json')) {
    const body = await parseJson<{ password?: string }>(request);
    return body.password || '';
  }
  throw new AppError('Unsupported content type', 'UNSUPPORTED_MEDIA_TYPE', 415);
}
