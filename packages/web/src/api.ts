import type {
  EnginesResponse,
  ProvidersResponse,
  RepairEvent,
  RepairRequest,
  RepairResult,
  SmtlibRequest,
  VerifyRequest,
  VerifyResult,
} from '@verifier/shared';

// The HTTP API (README "API"). Errors carry the server's own message.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function errorOf(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error ?? `The server answered HTTP ${res.status}.`, res.status);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal: signal ?? null });

export const getEngines = (signal?: AbortSignal) =>
  fetch('/api/engines', { signal: signal ?? null }).then(json<EnginesResponse>);

export const getProviders = (signal?: AbortSignal) =>
  fetch('/api/providers', { signal: signal ?? null }).then(json<ProvidersResponse>);

export const verify = (req: VerifyRequest, signal?: AbortSignal) =>
  post('/api/verify', req, signal).then(json<VerifyResult>);

export interface SmtlibFile {
  fileName: string;
  text: string;
}

export async function exportSmtlib(req: SmtlibRequest, signal?: AbortSignal): Promise<SmtlibFile> {
  const res = await post('/api/smtlib', req, signal);
  if (!res.ok) throw await errorOf(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${req.function}.smt2`;
  return { fileName, text: await res.text() };
}

interface ServerSentEvent {
  event: string;
  data: string;
}

function parseEvent(chunk: string): ServerSentEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue; // keepalive comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/**
 * Runs a repair over POST /api/repair/stream, reporting each event as it
 * arrives. Resolves with the final result; a busy server (429) answers with
 * a result of status 'error' instead of a stream.
 */
export async function streamRepair(
  req: RepairRequest,
  onEvent: (e: RepairEvent) => void,
  signal?: AbortSignal,
): Promise<RepairResult> {
  const res = await post('/api/repair/stream', req, signal);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('text/event-stream') || !res.body) {
    const body = (await res.json().catch(() => null)) as (RepairResult & { error?: string }) | null;
    if (body?.status) return body;
    throw new ApiError(body?.error ?? `The server answered HTTP ${res.status}.`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let result: RepairResult | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const ev = parseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (!ev) continue;
      if (ev.event === 'error') {
        throw new ApiError((JSON.parse(ev.data) as { error: string }).error, 500);
      }
      const event = JSON.parse(ev.data) as RepairEvent;
      onEvent(event);
      if (event.type === 'result') result = event.result;
    }
  }
  if (!result) throw new ApiError('The repair stream ended without a result.', 0);
  return result;
}
