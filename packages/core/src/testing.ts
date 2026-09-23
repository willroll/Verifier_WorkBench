import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { EngineId, EngineInfo } from '@verifier/shared';
import type { EngineDetector } from './detect';
import type { RunOptions, RunResult, Runner } from './runner';

// Record real checker runs once, then replay them so the whole verify()
// pipeline (analysis, per-function runs, parsing, aggregation) is testable in
// CI without CBMC or ESBMC installed. Re-record with `npm run record-fixtures`
// after changing any engine command line.

export interface RecordedRun {
  bin: string;
  args: string[];
  result: RunResult;
}

export interface Recording {
  scenario: string;
  engines: Record<EngineId, EngineInfo>;
  runs: RecordedRun[];
}

const key = (bin: string, args: string[]) => [path.basename(bin), ...args].join('\u0000');

export class RecordingRunner implements Runner {
  readonly runs: RecordedRun[] = [];

  constructor(private readonly inner: Runner) {}

  async run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const result = await this.inner.run(bin, args, opts);
    this.runs.push({ bin: path.basename(bin), args, result });
    return result;
  }
}

export class ReplayRunner implements Runner {
  private readonly queue = new Map<string, RunResult[]>();

  constructor(runs: RecordedRun[]) {
    for (const r of runs) {
      const k = key(r.bin, r.args);
      this.queue.set(k, [...(this.queue.get(k) ?? []), r.result]);
    }
  }

  run(bin: string, args: string[]): Promise<RunResult> {
    const k = key(bin, args);
    const results = this.queue.get(k);
    const next = results?.shift();
    if (!next) {
      return Promise.reject(
        new Error(`no recorded run for: ${path.basename(bin)} ${args.join(' ')} (re-record the fixtures)`),
      );
    }
    // Allow the same command to be replayed again once its recordings are used up.
    if (results && results.length === 0) results.push(next);
    return Promise.resolve(next);
  }
}

export class StaticDetector implements EngineDetector {
  constructor(private readonly engines: Record<EngineId, EngineInfo>) {}

  get(): Promise<Record<EngineId, EngineInfo>> {
    return Promise.resolve(this.engines);
  }
}

export function saveRecording(file: string, recording: Recording): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(recording), { level: 9 }));
}

export function loadRecording(file: string): Recording {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Recording;
}
