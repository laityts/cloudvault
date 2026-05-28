import type { Env } from '../../utils/types';
import { DAV_METHODS } from './shared';
import { handlePropfind, handleGet, handleHead } from './read';
import { handlePut, handleDelete, handleMkcol } from './write';
import { handleMove, handleCopy } from './move';

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: DAV_METHODS,
      DAV: '1',
      'MS-Author-Via': 'DAV',
    },
  });
}

export async function handleWebDav(request: Request, env: Env): Promise<Response> {
  switch (request.method) {
    case 'OPTIONS': return handleOptions();
    case 'PROPFIND': return handlePropfind(request, env);
    case 'GET': return handleGet(request, env);
    case 'HEAD': return handleHead(request, env);
    case 'PUT': return handlePut(request, env);
    case 'DELETE': return handleDelete(request, env);
    case 'MKCOL': return handleMkcol(request, env);
    case 'MOVE': return handleMove(request, env);
    case 'COPY': return handleCopy(request, env);
    default:
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: DAV_METHODS },
      });
  }
}
