import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CHECKS,
  type Assumption,
  type CheckId,
  type Counts,
  type EngineId,
  type EngineInfo,
  type Finding,
  type FunctionSummary,
  type RunStatus,
  type SmtlibRequest,
  type SolverId,
  type SolverUsed,
  type VerifyRequest,
  type VerifyResult,
} from '@verifier/shared';
import type { CoreConfig } from './config';
import {
  contractedCallsFrom,
  expandContracts,
  expandContractsForEntry,
  isTriviallyFalse,
  parseContracts,
  preconditionOf,
} from './contracts';
import { ENGINE_LABELS, SOLVER_LABELS, type EngineDetector } from './detect';
import { cbmc } from './engines/cbmc';
import { esbmc } from './engines/esbmc';
import {
  EngineError,
  type Analysis,
  type EngineAdapter,
  type FunctionInfo,
  type FunctionRun,
  type RunContext,
  type SolverSeen,
} from './engines/types';
import type { Runner } from './runner';
import { checkIncludes, safeFileName, withWorkspace } from './source';

export const ADAPTERS: Record<EngineId, EngineAdapter> = { cbmc, esbmc };

export interface VerifierDeps {
  config: CoreConfig;
  runner: Runner;
  detector: EngineDetector;
}

/** The request itself is invalid (maps to HTTP 400). */
export class RequestError extends Error {}

export type ProgressEvent =
  { type: 'analyzed'; functions: string[] } | { type: 'function'; summary: FunctionSummary };

interface Resolved {
  engine: EngineId;
  info: EngineInfo;
  solver: SolverId;
  unwind: number;
  checks: CheckId[];
  fileName: string;
}

type Options = Pick<VerifyRequest, 'code' | 'engine' | 'solver' | 'unwind' | 'checks' | 'fileName'>;

async function resolve(req: Options, deps: VerifierDeps): Promise<Resolved> {
  const { config } = deps;
  if (typeof req.code !== 'string') throw new RequestError('code must be a string');
  if (Buffer.byteLength(req.code) > config.maxCodeBytes) {
    throw new RequestError(`source is larger than the ${Math.round(config.maxCodeBytes / 1024)} KB limit`);
  }
  const engine = req.engine ?? config.defaultEngine;
  const engines = await deps.detector.get();
  const info = engines[engine];
  if (!info) throw new RequestError(`unknown engine: ${String(engine)}`);

  const unwind = req.unwind ?? config.defaultUnwind;
  if (!Number.isInteger(unwind) || unwind < 1 || unwind > config.maxUnwind) {
    throw new RequestError(`unwind must be an integer from 1 to ${config.maxUnwind}`);
  }

  const checks = req.checks ?? DEFAULT_CHECKS.filter((c) => info.checks.includes(c));
  const unsupported = checks.filter((c) => !info.checks.includes(c));
  if (unsupported.length) throw new RequestError(`${info.label} does not support: ${unsupported.join(', ')}`);

  let solver: SolverId;
  if (req.solver) {
    const s = info.solvers.find((x) => x.id === req.solver);
    if (!s) throw new RequestError(`${info.label} cannot use the ${req.solver} solver`);
    if (info.available && !s.available) {
      const usable = info.solvers.filter((x) => x.available).map((x) => x.id);
      throw new RequestError(
        `${s.label} is not installed on this host; ${info.label} can use: ${usable.join(', ') || 'none'}`,
      );
    }
    solver = req.solver;
  } else {
    solver = info.defaultSolver ?? info.solvers[0]!.id;
  }

  return { engine, info, solver, unwind, checks: [...new Set(checks)], fileName: safeFileName(req.fileName) };
}

/** Throws RequestError for a request verify() would reject, without running anything. */
export async function validateRequest(req: Options, deps: VerifierDeps): Promise<void> {
  await resolve(req, deps);
}

const zero = (): Counts => ({ proved: 0, refuted: 0, inconclusive: 0 });

function countOf(findings: Finding[]): Counts {
  const c = zero();
  for (const f of findings) c[f.status]++;
  return c;
}

const MAX_LOG = 64 * 1024;
const joinLog = (log: string[]) => {
  const text = log.join('\n');
  return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}\n… (log truncated)` : text;
};

function solverUsed(r: Resolved, seen: SolverSeen | undefined): SolverUsed {
  const detected = r.info.solvers.find((s) => s.id === r.solver);
  return {
    id: r.solver,
    label: seen?.label ?? SOLVER_LABELS[r.solver],
    version: seen?.version ?? detected?.version ?? null,
    encoding: seen?.encoding ?? (r.solver === 'minisat' ? 'SAT (bit-blasted)' : 'SMT'),
  };
}

function baseResult(r: Resolved, started: number): VerifyResult {
  return {
    engine: r.engine,
    engineLabel: ENGINE_LABELS[r.engine],
    engineVersion: r.info.version,
    available: r.info.available,
    status: 'error',
    counts: zero(),
    findings: [],
    functions: [],
    solver: null,
    harness: 'per-function',
    bounds: { unwind: r.unwind, unwindingAssertions: true },
    checks: r.checks,
    diagnostics: [],
    durationMs: Date.now() - started,
  };
}

/**
 * The preconditions the source states, each attributed to the function whose
 * body holds it (the last one starting at or before its line). A precondition
 * that can never hold is flagged vacuous: proofs under it mean nothing.
 */
function assumptionsFor(code: string, functions: FunctionSummary[]): Assumption[] {
  const byLine = [...functions].sort((a, b) => a.line - b.line);
  return parseContracts(code).map((p) => {
    let fn: string | undefined;
    for (const f of byLine) if (f.line <= p.line) fn = f.name;
    const a: Assumption = { expr: p.expr, line: p.line };
    if (fn) a.function = fn;
    if (isTriviallyFalse(p.expr)) a.vacuous = true;
    return a;
  });
}

/** Obligations a failed or timed-out run could not decide. */
function undecided(fn: FunctionInfo, reason: 'timeout' | 'error'): Finding[] {
  return fn.obligations.map((ob) => ({
    id: ob.id,
    status: 'inconclusive',
    kind: 'assertion',
    message: ob.message,
    file: '',
    line: ob.line,
    function: fn.name,
    entry: fn.name,
    model: [],
    trace: [],
    reason,
  }));
}

const POINTER_INPUT_NOTE =
  'The harness passed an arbitrary pointer (possibly NULL or dangling). If every caller guarantees a ' +
  'valid pointer, state that as a precondition; otherwise add a check.';

/** Flags findings that hinge on the harness choosing arbitrary pointer arguments. */
function annotate(f: Finding): Finding {
  const pointerInput = f.model.some((m) => m.role === 'input' && m.type?.includes('*'));
  if (f.status === 'refuted' && pointerInput && (f.kind === 'pointer' || f.kind === 'bounds')) {
    return { ...f, note: POINTER_INPUT_NOTE };
  }
  return f;
}

/**
 * Names a contract obligation after the callee's precondition it checks. The
 * finding's `function` is the callee, `entry` the caller under verification.
 */
function enrichContract(f: Finding, code: string, functions: FunctionInfo[]): Finding {
  if (f.kind !== 'contract') return f;
  const expr = preconditionOf(code, f.function, functions);
  const out: Finding = {
    ...f,
    message: expr ? `precondition of ${f.function}: ${expr}` : `precondition of ${f.function}`,
  };
  if (f.status === 'refuted') {
    out.note =
      `${f.entry} reaches ${f.function}(…) with arguments its precondition rejects; the ` +
      'counterexample is the caller input that does it. Guard the call or fix the caller — the callee ' +
      'contract stays as given.';
  }
  return out;
}

/**
 * The source one entry is verified against. When the entry calls a contracted
 * function, that callee's precondition becomes an assert the entry must satisfy,
 * so the run is written to its own directory (the shared file keeps every
 * precondition as an assume, which is right for a function verified on its own).
 */
async function entryContext(
  ctx: RunContext,
  engine: EngineId,
  code: string,
  entry: string,
  functions: FunctionInfo[],
): Promise<RunContext> {
  if (contractedCallsFrom(code, entry, functions).length === 0) return ctx;
  const dir = path.join(ctx.dir, `entry_${entry.replace(/\W/g, '_')}`);
  await fs.mkdir(dir, { recursive: true });
  const entryCode = expandContractsForEntry(code, engine, entry, functions);
  await fs.writeFile(path.join(dir, ctx.fileName), entryCode);
  return { ...ctx, dir, code: entryCode };
}

function summarize(fn: FunctionInfo, run: FunctionRun, findings: Finding[]): FunctionSummary {
  const counts = countOf(findings);
  const summary: FunctionSummary = {
    name: fn.name,
    line: fn.line,
    status:
      run.error && !run.timedOut
        ? 'error'
        : counts.refuted
          ? 'refuted'
          : counts.inconclusive
            ? 'inconclusive'
            : counts.proved
              ? 'proved'
              : 'no-obligations',
    counts,
    durationMs: run.durationMs,
  };
  if (fn.signature) summary.signature = fn.signature;
  if (run.error) summary.error = run.error;
  return summary;
}

export async function verify(
  req: VerifyRequest,
  deps: VerifierDeps,
  onProgress?: (e: ProgressEvent) => void,
): Promise<VerifyResult> {
  return (await verifyDetailed(req, deps, onProgress)).result;
}

export interface DetailedVerification {
  result: VerifyResult;
  /** Every function the engine found in the file (not only the verified subset), with type keys. */
  functions: FunctionInfo[];
}

/** verify(), plus the engine's per-function analysis (used by the repair guards). */
export async function verifyDetailed(
  req: VerifyRequest,
  deps: VerifierDeps,
  onProgress?: (e: ProgressEvent) => void,
): Promise<DetailedVerification> {
  const started = Date.now();
  const r = await resolve(req, deps);
  const base = () => baseResult(r, started);
  const none = (result: VerifyResult): DetailedVerification => ({ result, functions: [] });

  if (!r.info.available) {
    return none({
      ...base(),
      error: `${deps.config.bins[r.engine]} not found on this host`,
      hint: `Install ${r.info.label}, or set ${r.engine.toUpperCase()}_BIN`,
    });
  }
  const includeProblems = checkIncludes(req.code);
  if (includeProblems.length) {
    return none({ ...base(), diagnostics: includeProblems, error: includeProblems[0]!.message });
  }

  return withWorkspace(async (dir) => {
    const ctx: RunContext = {
      dir,
      fileName: r.fileName,
      // Preconditions become the engine's assume builtin; line numbers are kept.
      code: expandContracts(req.code, r.engine),
      checks: r.checks,
      unwind: r.unwind,
      solver: r.solver,
      config: deps.config,
      runner: deps.runner,
      log: [],
    };
    await fs.writeFile(path.join(dir, r.fileName), ctx.code);
    const adapter = ADAPTERS[r.engine];

    let analysis: Analysis;
    try {
      analysis = await adapter.analyze(ctx);
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      return none({ ...base(), error: e.message, raw: joinLog(ctx.log) });
    }
    if (analysis.error) {
      return none({
        ...base(),
        diagnostics: analysis.diagnostics,
        error: analysis.error,
        raw: joinLog(ctx.log),
      });
    }

    let targets = analysis.functions;
    if (req.functions?.length) {
      const unknown = req.functions.filter((n) => !targets.some((f) => f.name === n));
      if (unknown.length) throw new RequestError(`not defined in ${r.fileName}: ${unknown.join(', ')}`);
      targets = targets.filter((f) => req.functions!.includes(f.name));
    }
    if (targets.length === 0) {
      return {
        result: {
          ...base(),
          diagnostics: analysis.diagnostics,
          error: `no function definitions found in ${r.fileName}`,
        },
        functions: analysis.functions,
      };
    }
    if (targets.length > deps.config.maxFunctions) {
      return {
        result: {
          ...base(),
          diagnostics: analysis.diagnostics,
          error: `${targets.length} functions exceed the limit of ${deps.config.maxFunctions} per run; pass "functions" to verify a subset`,
        },
        functions: analysis.functions,
      };
    }
    onProgress?.({ type: 'analyzed', functions: targets.map((f) => f.name) });

    let seen: SolverSeen | undefined;
    // Every function gets a run, even one with no obligations of its own: a
    // call into library code (memcpy) or a check the engine only generates
    // during symbolic execution (ESBMC's pointer checks) would otherwise be missed.
    const perFunction = await Promise.all(
      targets.map(async (fn): Promise<{ summary: FunctionSummary; findings: Finding[] }> => {
        let run: FunctionRun;
        try {
          const runCtx = await entryContext(ctx, r.engine, req.code, fn.name, analysis.functions);
          run = await adapter.verifyFunction(runCtx, fn, analysis);
        } catch (e) {
          if (!(e instanceof EngineError)) throw e;
          run = { findings: [], durationMs: 0, unwindIncomplete: false, error: e.message };
        }
        seen ??= run.solverSeen;
        const findings = (
          run.findings.length || !run.error ? run.findings : undecided(fn, run.timedOut ? 'timeout' : 'error')
        )
          .map(annotate)
          .map((f) => enrichContract(f, req.code, analysis.functions));
        const summary = summarize(fn, run, findings);
        onProgress?.({ type: 'function', summary });
        return { summary, findings };
      }),
    );

    const findings = perFunction
      .flatMap((p) => p.findings)
      .sort((a, b) => a.line - b.line || a.entry.localeCompare(b.entry) || a.id.localeCompare(b.id));
    const functions = perFunction.map((p) => p.summary).sort((a, b) => a.line - b.line);
    const counts = countOf(findings);
    const checked = functions.filter((f) => f.status !== 'no-obligations');
    const allFailed = checked.length > 0 && checked.every((f) => f.status === 'error');
    const allTimedOut =
      checked.length > 0 && checked.every((f) => f.error !== undefined && /timed out/.test(f.error));

    let status: RunStatus;
    if (allFailed) status = 'error';
    else if (counts.refuted) status = 'refuted';
    else if (allTimedOut) status = 'timeout';
    else if (counts.inconclusive || checked.some((f) => f.status === 'error')) status = 'inconclusive';
    else status = 'proved';

    const assumptions = assumptionsFor(req.code, functions);
    const result: VerifyResult = {
      ...base(),
      status,
      counts,
      findings,
      functions,
      solver: solverUsed(r, seen),
      diagnostics: analysis.diagnostics,
      durationMs: Date.now() - started,
      ...(assumptions.length ? { assumptions } : {}),
      raw: joinLog(ctx.log),
    };
    if (status === 'error' || status === 'timeout')
      result.error = checked.find((f) => f.error)?.error ?? 'verification failed';
    return { result, functions: analysis.functions };
  });
}

export interface SmtlibExport {
  fileName: string;
  text: string;
}

export async function exportSmtlib(req: SmtlibRequest, deps: VerifierDeps): Promise<SmtlibExport> {
  const r = await resolve(req, deps);
  if (!r.info.available) throw new RequestError(`${r.info.label} is not installed on this host`);
  if (typeof req.function !== 'string' || !/^[A-Za-z_]\w*$/.test(req.function)) {
    throw new RequestError('function must be a C identifier');
  }
  if (typeof req.ref !== 'string' || !req.ref)
    throw new RequestError("ref is required (a finding's exportRef)");
  const includeProblems = checkIncludes(req.code);
  if (includeProblems.length) throw new RequestError(includeProblems[0]!.message);

  return withWorkspace(async (dir) => {
    const ctx: RunContext = {
      dir,
      fileName: r.fileName,
      code: expandContracts(req.code, r.engine),
      checks: r.checks,
      unwind: r.unwind,
      solver: r.solver,
      config: deps.config,
      runner: deps.runner,
      log: [],
    };
    await fs.writeFile(path.join(dir, r.fileName), ctx.code);
    const adapter = ADAPTERS[r.engine];
    let analysis: Analysis;
    try {
      analysis = await adapter.analyze(ctx);
    } catch (e) {
      if (e instanceof EngineError) throw new RequestError(e.message);
      throw e;
    }
    if (analysis.error) throw new RequestError(analysis.error);
    if (!analysis.functions.some((f) => f.name === req.function)) {
      throw new RequestError(`${req.function} is not defined in ${r.fileName}`);
    }

    let formula: string;
    try {
      formula = await adapter.exportSmt(ctx, req.function, req.ref, analysis);
    } catch (e) {
      if (e instanceof EngineError) throw new RequestError(e.message);
      throw e;
    }
    if (Buffer.byteLength(formula) > deps.config.maxSmtBytes) {
      throw new RequestError(
        `the formula is larger than the ${Math.round(deps.config.maxSmtBytes / 1024 / 1024)} MB export limit`,
      );
    }
    const header = [
      '; SMT-LIB formula exported by Verifier Workbench',
      `; engine: ${r.info.label} ${r.info.version ?? ''}`.trimEnd(),
      `; source: ${r.fileName}; entry function: ${req.function}; obligation: ${req.ref}`,
      `; bound: unwind ${r.unwind}; checks: ${r.checks.join(', ')}`,
      '; The formula asserts the negation of the obligation: sat means it can be violated',
      '; (the model is a counterexample); unsat means it holds within the bound.',
      '',
    ].join('\n');
    return { fileName: `${req.function}.${req.ref.replace(/[^\w.-]+/g, '_')}.smt2`, text: header + formula };
  });
}
