import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepairEvent, RepairResult } from '@verifier/shared';
import { ApiError, streamRepair } from '../src/api';
import { highlight } from '../src/highlight';
import { matchRoute } from '../src/router';
import { SAMPLE_CODE } from '../src/sample';

describe('highlight', () => {
  const text = (code: string) => highlight(code).map((line) => line.map((t) => t.text).join(''));
  const kinds = (line: string) => highlight(line)[0]!.map((t) => `${t.kind}:${t.text}`);

  it('keeps every character of the source', () => {
    expect(text(SAMPLE_CODE)).toEqual(SAMPLE_CODE.split('\n'));
  });

  it('colours types, keywords, numbers, strings and comments', () => {
    expect(kinds('static uint8_t buf[16];')).toEqual([
      'type:static',
      'plain: ',
      'type:uint8_t',
      'plain: buf[',
      'number:16',
      'plain:];',
    ]);
    expect(kinds('if (x < 0x1Fu) return "a\\"b"; // done')).toEqual([
      'keyword:if',
      'plain: (x < ',
      'number:0x1Fu',
      'plain:) ',
      'keyword:return',
      'plain: ',
      'string:"a\\"b"',
      'plain:; ',
      'comment:// done',
    ]);
    expect(kinds('#include <stdint.h>')).toEqual(['keyword:#include', 'plain: ', 'string:<stdint.h>']);
    expect(kinds('int x1 = y2;')).toEqual(['type:int', 'plain: x1 = y2;']);
  });

  it('carries block comments across lines', () => {
    const lines = highlight('a /* one\ntwo */ b\n/**/ c');
    expect(lines.map((l) => l.map((t) => t.kind))).toEqual([
      ['plain', 'comment'],
      ['comment', 'plain'],
      ['comment', 'plain'],
    ]);
  });
});

describe('matchRoute', () => {
  it('maps paths to views', () => {
    expect(matchRoute('/')).toEqual({ name: 'home' });
    expect(matchRoute('/new')).toEqual({ name: 'new' });
    expect(matchRoute('/new/')).toEqual({ name: 'new' });
    expect(matchRoute('/runs/7')).toEqual({ name: 'workbench', runId: '7' });
    expect(matchRoute('/runs/demo-patched')).toEqual({ name: 'workbench', runId: 'demo-patched' });
    expect(matchRoute('/runs/7/report')).toEqual({ name: 'report', runId: '7' });
    expect(matchRoute('/misra')).toEqual({ name: 'misra' });
    expect(matchRoute('/batch')).toEqual({ name: 'batch' });
    expect(matchRoute('/runs')).toEqual({ name: 'not-found' });
    expect(matchRoute('/runs/7/other')).toEqual({ name: 'not-found' });
    expect(matchRoute('/runs/a.b')).toEqual({ name: 'not-found' });
  });
});

describe('streamRepair', () => {
  afterEach(() => vi.unstubAllGlobals());

  const result = { status: 'repaired', iterations: [] } as unknown as RepairResult;
  const sse = (chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    );
  const event = (e: RepairEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

  it('reports events as they arrive, whatever the chunking', async () => {
    const body =
      ': keepalive\n\n' +
      event({ type: 'checking', iter: 0, step: 'verify' }) +
      event({ type: 'result', result });
    // Split mid-event, and mid-character for good measure.
    const chunks = [body.slice(0, 7), body.slice(7, 40), body.slice(40)];
    const fetch = vi.fn(() => Promise.resolve(sse(chunks)));
    vi.stubGlobal('fetch', fetch);
    const seen: string[] = [];
    const out = await streamRepair({ code: 'int x;', fileName: 'a.c' }, (e) => seen.push(e.type));
    expect(out).toEqual(result);
    expect(seen).toEqual(['checking', 'result']);
    expect(fetch).toHaveBeenCalledWith('/api/repair/stream', expect.objectContaining({ method: 'POST' }));
  });

  it('turns an error event into an ApiError', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(sse(['event: error\ndata: {"error":"internal error"}\n\n'])),
    );
    await expect(streamRepair({} as never, () => {})).rejects.toEqual(new ApiError('internal error', 500));
  });

  it('fails when the stream ends without a result', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(sse([event({ type: 'checking', iter: 0, step: 'verify' })])),
    );
    await expect(streamRepair({} as never, () => {})).rejects.toThrow('ended without a result');
  });

  it('returns the result a busy server answers with, and throws other errors', async () => {
    const busy = { ...result, status: 'error', error: 'busy' };
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(busy, { status: 429 })));
    await expect(streamRepair({} as never, () => {})).resolves.toEqual(busy);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(Response.json({ error: 'code is required' }, { status: 400 })),
    );
    await expect(streamRepair({} as never, () => {})).rejects.toEqual(new ApiError('code is required', 400));
  });
});
