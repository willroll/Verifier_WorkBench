import type {
  EquivalenceResult,
  ProposalOutcome,
  Proposer,
  Rejection,
  RepairEvent,
  RepairIteration,
  RepairRequest,
  RepairResult,
  VerifyResult,
} from '@verifier/shared';
import { safeFileName } from '../source';
import {
  RequestError,
  validateRequest,
  verifyDetailed,
  type DetailedVerification,
  type VerifierDeps,
} from '../verify';
import { patchOf, sameLayout } from './diff';
import { checkEquivalence } from './equivalence';
import {
  behaviorRejection,
  inconclusiveGuard,
  obligationsGuard,
  signatureGuard,
  sourceGuards,
} from './guards';
import { SYSTEM_PROMPT, attemptPrompt, stablePrompt, type Feedback } from './prompt';

// The verified repair loop. The model only proposes; every proposal goes
// through the guards, a fresh verification and a behavior proof, and only a
// candidate that passes all of them counts. A candidate with strictly fewer
// refuted obligations (and nothing else worse) becomes the version the next
// attempt improves on; one with none left is the result.

export interface RepairDeps extends VerifierDeps {
  proposer: Proposer;
}

export interface RepairOptions {
  onEvent?: (e: RepairEvent) => void;
  /** Cancels the repair between steps and aborts the model request in flight. */
  signal?: AbortSignal;
}

type FailureKind = Extract<ProposalOutcome, { ok: false }>['kind'];

/** Provider failures that another attempt would not fix. */
const STOPS: FailureKind[] = ['config', 'auth', 'aborted', 'rate-limit', 'network', 'api'];

function notVerifiable(r: VerifyResult): string {
  const errors = r.diagnostics
    .filter((d) => d.severity === 'error')
    .slice(0, 3)
    .map((d) => (d.line ? `line ${d.line}: ${d.message}` : d.message));
  const detail = errors.length ? errors.join('; ') : (r.error ?? 'the checker could not process it');
  return `The patched code could not be verified: ${detail}.`;
}

interface Best {
  code: string;
  result: VerifyResult;
  rationale?: string;
  equivalence: EquivalenceResult[];
  equivalenceNote?: string;
}

export async function repair(
  req: RepairRequest,
  deps: RepairDeps,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const limit = deps.config.repairMaxIters;
  const maxIters = req.maxIters ?? limit;
  if (!Number.isInteger(maxIters) || maxIters < 1 || maxIters > limit) {
    throw new RequestError(`maxIters must be an integer from 1 to ${limit}`);
  }
  const settings = {
    fileName: req.fileName,
    engine: req.engine,
    solver: req.solver,
    unwind: req.unwind,
    checks: req.checks,
  };
  // Reject a bad request before the first event, so a stream can still answer 400.
  await validateRequest({ ...settings, code: req.code }, deps);
  const emit = (e: RepairEvent) => opts.onEvent?.(e);
  const iterations: RepairIteration[] = [];
  const record = (it: RepairIteration) => {
    iterations.push(it);
    emit({ type: 'iteration', iteration: it });
  };
  const cancelled = () => opts.signal?.aborted === true;

  // 0. The original.
  emit({ type: 'checking', iter: 0, step: 'verify' });
  const base = await verifyDetailed({ ...settings, code: req.code }, deps);
  const b = base.result;
  record({
    iter: 0,
    kind: 'verify',
    counts: b.counts,
    findings: b.findings,
    status: b.status,
    durationMs: b.durationMs,
    outcome: 'baseline',
  });
  const about = {
    engineLabel: b.engineLabel,
    engineVersion: b.engineVersion,
    provider: deps.proposer.provider,
    model: deps.proposer.model,
  };
  const finish = (result: RepairResult): RepairResult => {
    emit({ type: 'result', result });
    return result;
  };

  if (b.status === 'error' || b.status === 'timeout') {
    return finish({
      status: 'error',
      iterations,
      ...about,
      error: `The original could not be verified: ${b.error ?? b.status}`,
    });
  }
  if (b.counts.refuted === 0) {
    if (b.status === 'proved')
      return finish({ status: 'already-proved', iterations, ...about, remaining: 0 });
    return finish({
      status: 'error',
      iterations,
      ...about,
      remaining: 0,
      error:
        `Nothing is refuted, but ${b.counts.inconclusive} obligation(s) are inconclusive with loops unwound ` +
        `${b.bounds.unwind} times. Raise the unwinding bound to decide them; there is nothing to repair yet.`,
    });
  }

  const fileName = safeFileName(req.fileName);
  const stable = stablePrompt({ fileName, code: req.code, result: b });
  let best: Best = { code: req.code, result: b, equivalence: [] };
  let feedback: Feedback | undefined;
  let stopped: string | undefined;
  let model = deps.proposer.model;

  for (let iter = 1; iter <= maxIters; iter++) {
    if (cancelled()) {
      stopped = 'The repair was cancelled.';
      break;
    }
    emit({ type: 'proposing', iter });
    const started = Date.now();
    const proposal = await deps.proposer.propose({
      system: SYSTEM_PROMPT,
      stable,
      attempt: attemptPrompt({
        iter,
        maxIters,
        ...(best.code !== req.code
          ? { best: { code: best.code, result: best.result, before: b.counts.refuted } }
          : {}),
        ...(feedback ? { feedback } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const elapsed = () => Date.now() - started;
    if (!proposal.ok) {
      record({ iter, kind: 'repair', outcome: 'error', error: proposal.error, durationMs: elapsed() });
      if (STOPS.includes(proposal.kind)) {
        stopped = proposal.error;
        break;
      }
      feedback = { kind: 'unusable', error: proposal.error };
      continue;
    }
    model = proposal.model;
    const code = sameLayout(req.code, proposal.code);
    const attempt: RepairIteration = {
      iter,
      kind: 'repair',
      rationale: proposal.rationale,
      diff: patchOf(best.code, code),
    };
    const reject = (rejection: Rejection, evidence: Partial<RepairIteration> = {}) => {
      record({ ...attempt, ...evidence, outcome: 'rejected', rejection, durationMs: elapsed() });
      feedback = { kind: 'rejected', rejection, diff: attempt.diff ?? [] };
    };

    emit({ type: 'checking', iter, step: 'guards' });
    const textual = sourceGuards(req.code, code, best.code);
    if (textual) {
      reject(textual);
      if (textual.guard === 'unchanged') break; // the model has nothing further to offer
      continue;
    }

    emit({ type: 'checking', iter, step: 'verify' });
    let verified: DetailedVerification;
    try {
      verified = await verifyDetailed({ ...settings, code }, deps);
    } catch (e) {
      if (!(e instanceof RequestError)) throw e;
      reject({ guard: 'does-not-compile', message: `The patched code could not be verified: ${e.message}.` });
      continue;
    }
    const c = verified.result;
    const checked: Partial<RepairIteration> = { counts: c.counts, findings: c.findings, status: c.status };
    if (c.status === 'error') {
      reject({ guard: 'does-not-compile', message: notVerifiable(c) }, checked);
      continue;
    }
    const structural = signatureGuard(base.functions, verified.functions) ?? inconclusiveGuard(b, c);
    if (structural) {
      reject(structural, checked);
      continue;
    }

    const accepted = c.counts.refuted === 0;
    if (!accepted && c.counts.refuted >= best.result.counts.refuted) {
      record({ ...attempt, ...checked, outcome: 'no-progress', durationMs: elapsed() });
      feedback = { kind: 'no-progress', diff: attempt.diff ?? [], result: c };
      continue;
    }
    if (cancelled()) {
      stopped = 'The repair was cancelled.';
      break;
    }

    emit({ type: 'checking', iter, step: 'equivalence' });
    const eq = await checkEquivalence(
      {
        original: req.code,
        candidate: code,
        fileName,
        checks: c.checks,
        unwind: c.bounds.unwind,
        solver: c.solver?.id ?? 'minisat',
      },
      deps,
    );
    const evidence: Partial<RepairIteration> = {
      ...checked,
      equivalence: eq.results,
      ...(eq.unavailable ? { equivalenceNote: eq.unavailable } : {}),
    };
    const behavior = eq.rejection ?? behaviorRejection(eq.results) ?? obligationsGuard(b, c, eq.results);
    if (behavior) {
      reject(behavior, evidence);
      continue;
    }

    if (accepted) {
      record({ ...attempt, ...evidence, outcome: 'accepted', durationMs: elapsed() });
      return finish({
        status: 'repaired',
        iterations,
        ...about,
        model,
        rationale: proposal.rationale,
        finalCode: code,
        finalResult: c,
        diff: patchOf(req.code, code),
        remaining: 0,
        equivalence: eq.results,
        ...(eq.unavailable ? { equivalenceNote: eq.unavailable } : {}),
        ...(c.counts.inconclusive ? { inconclusive: c.counts.inconclusive } : {}),
      });
    }
    record({ ...attempt, ...evidence, outcome: 'improved', durationMs: elapsed() });
    best = {
      code,
      result: c,
      rationale: proposal.rationale,
      equivalence: eq.results,
      ...(eq.unavailable ? { equivalenceNote: eq.unavailable } : {}),
    };
    feedback = undefined; // the next prompt shows the improved version and what is still refuted
  }

  const improved = best.code !== req.code;
  return finish({
    status: stopped ? 'error' : 'unrepaired',
    iterations,
    ...about,
    model,
    remaining: best.result.counts.refuted,
    ...(improved
      ? {
          finalCode: best.code,
          finalResult: best.result,
          diff: patchOf(req.code, best.code),
          equivalence: best.equivalence,
          ...(best.rationale ? { rationale: best.rationale } : {}),
          ...(best.equivalenceNote ? { equivalenceNote: best.equivalenceNote } : {}),
        }
      : {}),
    ...(stopped ? { error: stopped } : {}),
  });
}
