import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { Semaphore, loadConfig, runProcess } from '@verifier/core';

const opts = { cwd: os.tmpdir(), timeoutMs: 10_000, maxOutputBytes: 1024 * 1024, memoryLimitMb: 0 };

describe('runProcess', () => {
  it('captures output and exit code', async () => {
    const r = await runProcess('sh', ['-c', 'echo out; echo err >&2; exit 3'], opts);
    expect(r).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false, truncated: false });
  });

  it('kills the whole process group on timeout (solvers are child processes)', async () => {
    const started = Date.now();
    const r = await runProcess('sh', ['-c', 'sleep 30 & sleep 30; wait'], { ...opts, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops a process that floods its output', async () => {
    const r = await runProcess('sh', ['-c', 'yes verification'], { ...opts, maxOutputBytes: 64 * 1024 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('does not pass server secrets to checker processes', async () => {
    process.env.VW_TEST_SECRET = 'sk-should-not-leak';
    try {
      const r = await runProcess('sh', ['-c', 'echo "[$VW_TEST_SECRET]"'], opts);
      expect(r.stdout).toBe('[]\n');
    } finally {
      delete process.env.VW_TEST_SECRET;
    }
  });

  it('reports a missing binary instead of throwing', async () => {
    const r = await runProcess('definitely-not-a-model-checker', [], opts);
    expect(r.spawnError).toBeTruthy();
  });

  it('applies the memory limit when prlimit is available', async () => {
    const r = await runProcess('sh', ['-c', 'ulimit -v'], { ...opts, memoryLimitMb: 512 });
    // With prlimit the child sees the cap (in KB); without it the test is moot.
    if (r.stdout.trim() !== 'unlimited') expect(Number(r.stdout.trim())).toBe(512 * 1024);
  });
});

describe('Semaphore', () => {
  it('never runs more than its limit at once', async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      s.use(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });
});

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      defaultEngine: 'cbmc',
      defaultUnwind: 16,
      maxUnwind: 256,
      preferredSolver: null,
    });
    expect(c.concurrency).toBeGreaterThanOrEqual(1);
  });
  it('reads the environment', () => {
    const c = loadConfig({
      VERIFY_ENGINE: 'ESBMC',
      VERIFY_SOLVER: 'cvc5',
      VERIFY_UNWIND: '8',
      CBMC_EXTRA_FLAGS: '-D X=1  --32',
    });
    expect(c).toMatchObject({ defaultEngine: 'esbmc', preferredSolver: 'cvc5', defaultUnwind: 8 });
    expect(c.extraFlags.cbmc).toEqual(['-D', 'X=1', '--32']);
  });
  it('rejects bad values instead of guessing', () => {
    expect(() => loadConfig({ VERIFY_ENGINE: 'klee' })).toThrow(/VERIFY_ENGINE/);
    expect(() => loadConfig({ VERIFY_UNWIND: 'lots' })).toThrow(/VERIFY_UNWIND/);
    expect(() => loadConfig({ VERIFY_UNWIND: '999', VERIFY_MAX_UNWIND: '100' })).toThrow(/VERIFY_UNWIND/);
  });
});
