import type { Env } from './utils/types';
import { json } from './utils/response';
import { AppError } from './utils/handler';

export type RouteMethod =
  | '*'
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'PATCH'
  | 'PROPFIND'
  | 'PROPPATCH'
  | 'MKCOL'
  | 'MOVE'
  | 'COPY'
  | 'LOCK'
  | 'UNLOCK';

export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response> | Response;

export type Middleware = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null> | Response | null;

export interface Route {
  method: RouteMethod | RouteMethod[];
  /** Pattern with `:name` single-segment params or trailing `*` wildcard. E.g. '/api/files/:id', '/dav/*'. */
  pattern: string;
  handler: RouteHandler;
  /** Pre-handler middleware. First non-null Response short-circuits. */
  middleware?: Middleware[];
}

type Segment = { kind: 'literal'; value: string } | { kind: 'param'; name: string } | { kind: 'wild' };

interface CompiledRoute {
  methods: ReadonlySet<string>;
  any: boolean;
  segments: Segment[];
  hasWildcard: boolean;
  handler: RouteHandler;
  middleware: Middleware[];
}

function compile(route: Route): CompiledRoute {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const any = methods.includes('*');
  const rawSegments = route.pattern.split('/').filter(Boolean);
  const segments: Segment[] = rawSegments.map((s, i) => {
    if (s === '*') {
      if (i !== rawSegments.length - 1) {
        throw new Error(`Route pattern "${route.pattern}": "*" must be the final segment`);
      }
      return { kind: 'wild' };
    }
    if (s.startsWith(':')) return { kind: 'param', name: s.slice(1) };
    return { kind: 'literal', value: s };
  });
  return {
    methods: new Set(methods),
    any,
    segments,
    hasWildcard: segments.length > 0 && segments[segments.length - 1].kind === 'wild',
    handler: route.handler,
    middleware: route.middleware ?? [],
  };
}

export function createRouter(routes: Route[]) {
  const compiled = routes.map(compile);

  return async function dispatch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    for (const r of compiled) {
      if (!r.any && !r.methods.has(request.method)) continue;
      if (!matches(r, segments)) continue;

      for (const mw of r.middleware) {
        const intercept = await mw(request, env, ctx);
        if (intercept) return intercept;
      }
      try {
        return await r.handler(request, env, ctx);
      } catch (e) {
        if (e instanceof AppError) {
          return json({ error: e.message, code: e.code }, e.status);
        }
        throw e;
      }
    }
    return null;
  };
}

function matches(route: CompiledRoute, segments: string[]): boolean {
  if (route.hasWildcard) {
    if (segments.length < route.segments.length - 1) return false;
  } else if (segments.length !== route.segments.length) {
    return false;
  }
  for (let i = 0; i < route.segments.length; i++) {
    const pat = route.segments[i];
    if (pat.kind === 'wild') return true;
    const seg = segments[i];
    if (pat.kind === 'literal') {
      if (pat.value !== seg) return false;
    }
  }
  return true;
}
