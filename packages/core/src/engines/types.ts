import type { CheckId, Diagnostic, EngineId, Finding, SolverId } from '@verifier/shared';
import type { CoreConfig } from '../config';
import type { Runner } from '../runner';

/** Everything an adapter needs for one verification of one source file. */
export interface RunContext {
  /** Private workspace directory; the source is written here as `fileName`. */
  dir: string;
  fileName: string;
  code: string;
  checks: CheckId[];
  unwind: number;
  solver: SolverId;
  config: CoreConfig;
  runner: Runner;
  /** Condensed log: command lines and engine messages, returned as `raw`. */
  log: string[];
}

/** A proof obligation known before verification (from --show-properties / --show-claims). */
export interface Obligation {
  id: string;
  function: string;
  line: number;
  message: string;
  exportRef?: string;
}

export interface FunctionInfo {
  name: string;
  line: number;
  signature?: string;
  /** Obligations located in this function. */
  obligations: Obligation[];
}

export interface Analysis {
  /** Functions defined (with a body) in the submitted file, in source order. */
  functions: FunctionInfo[];
  diagnostics: Diagnostic[];
  /** Set when the file could not be analyzed at all (e.g. it does not compile). */
  error?: string;
  /** Adapter-private data carried from analyze() to later calls. */
  extra?: unknown;
}

export interface SolverSeen {
  label: string;
  version: string | null;
  encoding: string;
}

export interface FunctionRun {
  findings: Finding[];
  durationMs: number;
  solverSeen?: SolverSeen;
  /** A loop somewhere on this entry's paths needs more unwinding; its proofs were downgraded. */
  unwindIncomplete: boolean;
  timedOut?: boolean;
  error?: string;
}

export interface EngineAdapter {
  id: EngineId;
  label: string;
  analyze(ctx: RunContext): Promise<Analysis>;
  verifyFunction(ctx: RunContext, fn: FunctionInfo, analysis: Analysis): Promise<FunctionRun>;
  /** SMT-LIB text for one obligation checked from `entry`. */
  exportSmt(ctx: RunContext, entry: string, ref: string, analysis: Analysis): Promise<string>;
}

export class EngineError extends Error {}
