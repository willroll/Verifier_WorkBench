import { spawn, spawnSync } from 'node:child_process';

// Every checker process goes through a Runner. The local runner below adds
// timeouts, an output cap, a memory cap and a global concurrency limit. A
// SaaS deployment swaps in an isolated runner (per-job container or sandbox)
// behind the same interface.

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  memoryLimitMb: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output exceeded maxOutputBytes and the process was killed. */
  truncated: boolean;
  /** The binary could not be started (e.g. not installed). */
  spawnError?: string;
  durationMs: number;
}

export interface Runner {
  run(bin: string, args: string[], opts: RunOptions): Promise<RunResult>;
}

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter; only free it when nobody waits.
      if (next) next();
      else this.active--;
    }
  }
}

let prlimitAvailable: boolean | undefined;
function hasPrlimit(): boolean {
  if (prlimitAvailable === undefined) {
    const probe = spawnSync('prlimit', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    prlimitAvailable = probe.status === 0;
  }
  return prlimitAvailable;
}

// Checker processes see no server secrets (API keys, tokens): only what they need to run.
function childEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    TMPDIR: cwd,
    LANG: 'C',
    LC_ALL: 'C',
  };
}

export class LocalRunner implements Runner {
  private readonly slots: Semaphore;

  constructor(concurrency: number) {
    this.slots = new Semaphore(concurrency);
  }

  run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
    return this.slots.use(() => runProcess(bin, args, opts));
  }
}

export function runProcess(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  let file = bin;
  let argv = args;
  if (opts.memoryLimitMb > 0 && hasPrlimit()) {
    const bytes = opts.memoryLimitMb * 1024 * 1024;
    file = 'prlimit';
    argv = [`--as=${bytes}`, '--', bin, ...args];
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    // detached: the checker gets its own process group, so a kill also reaches
    // the solver processes it spawns (CBMC runs z3/cvc5 as child processes).
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: childEnv(opts.cwd),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > opts.maxOutputBytes) {
        truncated = true;
        killGroup();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    const finish = (
      result: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut' | 'truncated' | 'durationMs'>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.on('close', (code, signal) => {
      // Reap anything the checker left behind in its group.
      killGroup();
      finish({ code, signal });
    });
  });
}
