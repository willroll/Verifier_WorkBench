import { spawn } from 'node:child_process';
import {
  CHECK_IDS,
  type CheckId,
  type EngineId,
  type EngineInfo,
  type SolverId,
  type SolverInfo,
} from '@verifier/shared';
import type { CoreConfig } from './config';

// What is actually installed on this host: engines, and which SAT/SMT back
// ends each can use. CBMC runs SMT solvers as external binaries, so a solver
// is offered only when its binary answers; ESBMC links its solvers in and
// lists them itself.

export const SOLVER_LABELS: Record<SolverId, string> = {
  minisat: 'MiniSAT',
  z3: 'Z3',
  cvc5: 'cvc5',
  bitwuzla: 'Bitwuzla',
  boolector: 'Boolector',
};

export const ENGINE_LABELS: Record<EngineId, string> = { cbmc: 'CBMC', esbmc: 'ESBMC' };

export const ENGINE_CHECKS: Record<EngineId, CheckId[]> = {
  cbmc: [...CHECK_IDS],
  // ESBMC has no counterpart to CBMC's --conversion-check.
  esbmc: CHECK_IDS.filter((c) => c !== 'conversion'),
};

/** Solver each engine uses when given no solver flag. */
export const NATIVE_SOLVER: Record<EngineId, SolverId> = { cbmc: 'minisat', esbmc: 'bitwuzla' };

/** Runs `bin args` briefly and returns its combined output, or null if it cannot run. */
export function probe(bin: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 || out.trim() ? out : null));
  });
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
const semver = (s: string) => /(\d+\.\d+(?:\.\d+)?)/.exec(s)?.[1] ?? null;

export async function detectEngines(config: CoreConfig): Promise<Record<EngineId, EngineInfo>> {
  const [cbmcOut, esbmcOut, z3Out, cvc5Out, bitwuzlaOut] = await Promise.all([
    probe(config.bins.cbmc, ['--version']),
    probe(config.bins.esbmc, ['--version']),
    probe(config.bins.z3, ['--version']),
    probe(config.bins.cvc5, ['--version']),
    probe(config.bins.bitwuzla, ['--version']),
  ]);

  const cbmcAvailable = cbmcOut !== null;
  const external = (id: SolverId, out: string | null): SolverInfo => ({
    id,
    label: SOLVER_LABELS[id],
    available: cbmcAvailable && out !== null,
    version: out ? semver(out) : null,
    builtIn: false,
  });
  const cbmcSolvers: SolverInfo[] = [
    { id: 'minisat', label: SOLVER_LABELS.minisat, available: cbmcAvailable, version: null, builtIn: true },
    external('z3', z3Out),
    external('cvc5', cvc5Out),
    external('bitwuzla', bitwuzlaOut),
  ];

  const esbmcAvailable = esbmcOut !== null;
  const listed = esbmcAvailable ? ((await probe(config.bins.esbmc, ['--list-solvers'])) ?? '') : '';
  const names = /Available solvers:\s*(.*)/.exec(listed)?.[1]?.split(/\s+/) ?? [];
  const esbmcSolvers: SolverInfo[] = (['bitwuzla', 'z3', 'cvc5', 'boolector'] as const).map((id) => ({
    id,
    label: SOLVER_LABELS[id],
    available: esbmcAvailable && names.includes(id),
    version: null,
    builtIn: true,
  }));

  return {
    cbmc: engineInfo('cbmc', cbmcOut, cbmcSolvers, config),
    esbmc: engineInfo('esbmc', esbmcOut, esbmcSolvers, config),
  };
}

function engineInfo(
  id: EngineId,
  versionOut: string | null,
  solvers: SolverInfo[],
  config: CoreConfig,
): EngineInfo {
  const available = versionOut !== null;
  const usable = (s: SolverId | null) => s !== null && solvers.some((x) => x.id === s && x.available);
  // Preference: operator's VERIFY_SOLVER, then Z3 (the SMT default the product
  // is built around), then whatever the engine uses natively.
  const defaultSolver = !available
    ? null
    : usable(config.preferredSolver)
      ? config.preferredSolver
      : usable('z3')
        ? 'z3'
        : NATIVE_SOLVER[id];
  return {
    id,
    label: ENGINE_LABELS[id],
    available,
    version: versionOut ? firstLine(versionOut) : null,
    solvers,
    defaultSolver,
    checks: ENGINE_CHECKS[id],
  };
}

/** Source of engine/solver availability; tests substitute a fixed snapshot. */
export interface EngineDetector {
  get(): Promise<Record<EngineId, EngineInfo>>;
}

/** Caches detection so every request does not spawn five probes. */
export class Detector implements EngineDetector {
  private cached: { at: number; value: Promise<Record<EngineId, EngineInfo>> } | null = null;

  constructor(
    private readonly config: CoreConfig,
    private readonly ttlMs = 60_000,
  ) {}

  get(): Promise<Record<EngineId, EngineInfo>> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > this.ttlMs) {
      this.cached = { at: now, value: detectEngines(this.config) };
    }
    return this.cached.value;
  }
}
