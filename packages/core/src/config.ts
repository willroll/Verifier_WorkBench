import os from 'node:os';
import { ENGINE_IDS, SOLVER_IDS, type EngineId, type SolverId } from '@verifier/shared';

export interface CoreConfig {
  bins: {
    cbmc: string;
    esbmc: string;
    z3: string;
    cvc5: string;
    bitwuzla: string;
  };
  /** Extra flags appended verbatim to every engine run (operator-controlled). */
  extraFlags: Record<EngineId, string[]>;
  defaultEngine: EngineId;
  /** Preferred solver when a request names none; falls back to the engine's own default. */
  preferredSolver: SolverId | null;
  defaultUnwind: number;
  maxUnwind: number;
  /** Wall-clock limit per checker process. */
  timeoutMs: number;
  /** Per-process stdout+stderr cap; a process that exceeds it is killed. */
  maxOutputBytes: number;
  /** Address-space limit per checker process via prlimit; 0 disables. */
  memoryLimitMb: number;
  /** Checker processes allowed to run at once, across all requests. */
  concurrency: number;
  maxFunctions: number;
  maxCodeBytes: number;
  /** Largest SMT-LIB export returned to a client. */
  maxSmtBytes: number;
  /** Repair attempts per request: the default and the most a request may ask for. */
  repairMaxIters: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T;
function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: null): T | null;
function oneOf<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

function flags(env: Env, name: string): string[] {
  return (env[name] ?? '').split(/\s+/).filter(Boolean);
}

export function loadConfig(env: Env = process.env): CoreConfig {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const maxUnwind = int(env, 'VERIFY_MAX_UNWIND', 256, 1, 100_000);
  return {
    bins: {
      cbmc: env.CBMC_BIN || 'cbmc',
      esbmc: env.ESBMC_BIN || 'esbmc',
      z3: env.Z3_BIN || 'z3',
      cvc5: env.CVC5_BIN || 'cvc5',
      bitwuzla: env.BITWUZLA_BIN || 'bitwuzla',
    },
    extraFlags: {
      cbmc: flags(env, 'CBMC_EXTRA_FLAGS'),
      esbmc: flags(env, 'ESBMC_EXTRA_FLAGS'),
    },
    defaultEngine: oneOf(env, 'VERIFY_ENGINE', ENGINE_IDS, 'cbmc'),
    preferredSolver: oneOf(env, 'VERIFY_SOLVER', SOLVER_IDS, null),
    defaultUnwind: int(env, 'VERIFY_UNWIND', 16, 1, maxUnwind),
    maxUnwind,
    timeoutMs: int(env, 'VERIFY_TIMEOUT_MS', 60_000, 1_000, 3_600_000),
    maxOutputBytes: int(env, 'VERIFY_MAX_OUTPUT_BYTES', 32 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024),
    memoryLimitMb: int(env, 'VERIFY_MEMORY_LIMIT_MB', 4096, 0, 1024 * 1024),
    concurrency: int(env, 'VERIFY_CONCURRENCY', Math.max(1, Math.min(4, cpus - 1)), 1, 256),
    maxFunctions: int(env, 'VERIFY_MAX_FUNCTIONS', 64, 1, 10_000),
    maxCodeBytes: int(env, 'VERIFY_MAX_CODE_BYTES', 200 * 1024, 1024, 16 * 1024 * 1024),
    maxSmtBytes: int(env, 'VERIFY_MAX_SMT_BYTES', 8 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
    repairMaxIters: int(env, 'REPAIR_MAX_ITERS', 3, 1, 10),
  };
}
