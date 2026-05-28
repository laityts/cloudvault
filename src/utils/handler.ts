import type { Env } from './types';
import { json } from './response';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string = 'INTERNAL', status: number = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export type RouteParams = Record<string, string>;

export type Handler<P extends RouteParams = RouteParams> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: P,
) => Promise<Response> | Response;

export function wrap<P extends RouteParams = RouteParams>(handler: Handler<P>): Handler<P> {
  return async (request, env, ctx, params) => {
    try {
      return await handler(request, env, ctx, params);
    } catch (e) {
      if (e instanceof AppError) {
        return json({ error: e.message, code: e.code }, e.status);
      }
      const message = e instanceof Error ? e.message : 'Internal server error';
      console.error('Unhandled handler error:', message, e);
      return json({ error: message, code: 'INTERNAL' }, 500);
    }
  };
}
