// API contract shared by the verification core, the HTTP server and the web app.
//
// VerifyResult and Finding stay backward compatible with the prototype UI
// (docs/design-handoff.md, "Backend API"): every field it reads keeps its name and meaning.
// New fields are additive.

export const ENGINE_IDS = ['cbmc', 'esbmc'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

// SAT/SMT back ends. `minisat` is CBMC's built-in SAT solver; the others are SMT solvers.
export const SOLVER_IDS = ['minisat', 'z3', 'cvc5', 'bitwuzla', 'boolector'] as const;
export type SolverId = (typeof SOLVER_IDS)[number];

// Safety checks the engines instrument as proof obligations.
export const CHECK_IDS = [
  'bounds',
  'pointer',
  'div-by-zero',
  'signed-overflow',
  'unsigned-overflow',
  'conversion',
  'undefined-shift',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const DEFAULT_CHECKS: readonly CheckId[] = CHECK_IDS;

// proved: holds on every execution (loops fully unwound within the bound).
// refuted: the engine found a concrete counterexample.
// inconclusive: not decided, e.g. the loop bound was too small or the run timed out.
export type ObligationStatus = 'proved' | 'refuted' | 'inconclusive';

export type ObligationKind =
  'overflow' | 'bounds' | 'div-by-zero' | 'pointer' | 'conversion' | 'shift' | 'unwind' | 'assertion';

export type InconclusiveReason = 'unwind-bound' | 'not-checked' | 'unknown' | 'timeout' | 'error';

export type RunStatus = 'proved' | 'refuted' | 'inconclusive' | 'error' | 'timeout';

export interface WitnessValue {
  name: string;
  /** Value as the engine printed it (decimal for integers). */
  value: string;
  /** 'input': an argument of the function under verification. 'state': a value on the failing path. */
  role: 'input' | 'state';
  type?: string;
  width?: number;
  /** Two's-complement bit pattern as hex, e.g. '0x7fffffff'. */
  hex?: string;
}

export interface TraceStep {
  file: string;
  line: number;
  function: string;
  text: string;
}

export interface Finding {
  /** Engine property id, e.g. 'avg.overflow.1' (CBMC) or 'avg.arithmetic-overflow.1' (ESBMC). */
  id: string;
  status: ObligationStatus;
  kind: ObligationKind;
  message: string;
  file: string;
  line: number;
  /** Function the obligation is located in. */
  function: string;
  /** Function whose per-function harness checked it (differs for library code such as memcpy). */
  entry: string;
  /** Counterexample assignments; empty unless refuted. Named `model` for prototype compatibility. */
  model: WitnessValue[];
  trace: TraceStep[];
  reason?: InconclusiveReason;
  /** Caveat for the reader, e.g. when the result depends on the harness's arbitrary pointer inputs. */
  note?: string;
  /** Opaque reference for POST /api/smtlib; absent when the obligation cannot be exported. */
  exportRef?: string;
}

export interface Counts {
  proved: number;
  refuted: number;
  inconclusive: number;
}

export type FunctionStatus = 'proved' | 'refuted' | 'inconclusive' | 'no-obligations' | 'error';

export interface FunctionSummary {
  name: string;
  line: number;
  /** Source-level signature when the engine reports one, e.g. 'int32_t avg(int32_t a, int32_t b)'. */
  signature?: string;
  status: FunctionStatus;
  counts: Counts;
  durationMs: number;
  error?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface SolverUsed {
  id: SolverId;
  label: string;
  version: string | null;
  /** How the engine encoded the problem, as it reported it, e.g. 'SMT-LIB QF_AUFBV'. */
  encoding: string;
}

export interface VerifyRequest {
  code: string;
  fileName?: string;
  engine?: EngineId;
  solver?: SolverId;
  /** Loop unwinding bound. Loops that may run longer make obligations inconclusive, never proved. */
  unwind?: number;
  checks?: CheckId[];
  /** Restrict verification to these functions (default: every function defined in the file). */
  functions?: string[];
}

export interface VerifyResult {
  engine: EngineId;
  engineLabel: string;
  engineVersion: string | null;
  /** False when the engine is not installed on this host. */
  available: boolean;
  status: RunStatus;
  counts: Counts;
  findings: Finding[];
  functions: FunctionSummary[];
  solver: SolverUsed | null;
  harness: 'per-function';
  bounds: { unwind: number; unwindingAssertions: boolean };
  checks: CheckId[];
  diagnostics: Diagnostic[];
  durationMs: number;
  /** Condensed engine log (command lines and messages), truncated. */
  raw?: string;
  error?: string;
  hint?: string;
}

export interface SmtlibRequest {
  code: string;
  fileName?: string;
  engine?: EngineId;
  solver?: SolverId;
  unwind?: number;
  checks?: CheckId[];
  /** The finding's `entry`. */
  function: string;
  /** The finding's `exportRef`. */
  ref: string;
}

export interface SolverInfo {
  id: SolverId;
  label: string;
  available: boolean;
  version: string | null;
  /** Linked into the engine (ESBMC) rather than an external binary (CBMC's SMT back ends). */
  builtIn: boolean;
}

export interface EngineInfo {
  id: EngineId;
  label: string;
  available: boolean;
  version: string | null;
  solvers: SolverInfo[];
  defaultSolver: SolverId | null;
  checks: CheckId[];
}

export interface EnginesResponse {
  default: EngineId;
  engines: Record<EngineId, EngineInfo>;
  limits: { maxUnwind: number; defaultUnwind: number; maxCodeBytes: number };
}

// ---- Verified repair -------------------------------------------------------

export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'custom'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** False when its API key (or base URL) is not set on the server. */
  configured: boolean;
  model: string | null;
  /** Environment variable that would configure it, when not configured. */
  missing?: string;
}

export interface ProvidersResponse {
  default: ProviderId;
  providers: ProviderInfo[];
}

export type RepairStatus = 'repaired' | 'unrepaired' | 'already-proved' | 'error';

export interface RepairRequest extends Omit<VerifyRequest, 'functions'> {
  provider?: ProviderId;
  /** Repair attempts before giving up (the server sets the default and the limit, 3 unless configured). */
  maxIters?: number;
}

export interface DiffLine {
  type: '+' | '-' | ' ' | '@';
  text: string;
  /** 1-based line in the old file (context and removed lines). */
  oldLine?: number;
  /** 1-based line in the new file (context and added lines). */
  newLine?: number;
}

/** Why a candidate patch was refused before it could count. */
export type GuardId =
  | 'unchanged'
  | 'empty'
  | 'includes'
  | 'verifier-intrinsics'
  | 'macros'
  | 'assertions'
  | 'termination'
  | 'does-not-compile'
  | 'signature'
  | 'globals'
  | 'inconclusive'
  | 'obligations'
  | 'behavior';

export interface Rejection {
  guard: GuardId;
  message: string;
}

/**
 * Whether a changed function still computes what the original computed,
 * proved by the model checker on every input where the original has no
 * undefined behavior (return value and global state).
 */
export interface EquivalenceResult {
  function: string;
  status: 'equivalent' | 'different' | 'inconclusive' | 'skipped';
  /** Why it was skipped or inconclusive, or what differs. */
  reason?: string;
  /** For 'different': the inputs that show it. */
  inputs?: WitnessValue[];
  /** For 'different': what each version produced (the return value, or the differing global or element). */
  original?: string;
  candidate?: string;
}

export interface RepairIteration {
  iter: number;
  kind: 'verify' | 'repair';
  counts?: Counts;
  findings?: Finding[];
  status?: RunStatus;
  durationMs?: number;
  rationale?: string;
  diff?: DiffLine[];
  error?: string;
  /**
   * baseline: the original. accepted: fully verified, becomes the result.
   * improved: fewer refuted obligations, kept as the new baseline.
   * no-progress: valid but not fewer refuted obligations. rejected: failed a guard.
   * error: the model gave no usable answer.
   */
  outcome?: 'baseline' | 'accepted' | 'improved' | 'no-progress' | 'rejected' | 'error';
  rejection?: Rejection;
  equivalence?: EquivalenceResult[];
  /** Why no behavior proof was attempted for this candidate (e.g. CBMC is not installed). */
  equivalenceNote?: string;
}

export interface RepairResult {
  status: RepairStatus;
  iterations: RepairIteration[];
  rationale?: string;
  finalCode?: string;
  /** Verification of `finalCode`, as the loop ran it. */
  finalResult?: VerifyResult;
  diff?: DiffLine[];
  remaining?: number;
  engineLabel?: string;
  engineVersion?: string | null;
  provider?: ProviderId;
  model?: string;
  /** Behavior-preservation evidence for the accepted patch. */
  equivalence?: EquivalenceResult[];
  equivalenceNote?: string;
  /** Obligations of the final code still inconclusive (never more than the original had). */
  inconclusive?: number;
  error?: string;
}

export type RepairEvent =
  | { type: 'iteration'; iteration: RepairIteration }
  | { type: 'proposing'; iter: number }
  | { type: 'checking'; iter: number; step: 'guards' | 'verify' | 'equivalence' }
  | { type: 'result'; result: RepairResult };

// ---- Model proposals (the contract between the repair loop and providers) ----

export interface ProposalRequest {
  system: string;
  /** Identical across attempts (the original source and its failures): cacheable. */
  stable: string;
  /** Attempt-specific feedback. */
  attempt: string;
  signal?: AbortSignal;
}

export type ProposalOutcome =
  | { ok: true; code: string; rationale: string; model: string }
  | {
      ok: false;
      /** config/auth/aborted stop the loop; the others count as a failed attempt. */
      kind:
        | 'config'
        | 'auth'
        | 'rate-limit'
        | 'network'
        | 'api'
        | 'truncated'
        | 'refused'
        | 'invalid'
        | 'aborted';
      error: string;
    };

export interface Proposer {
  provider: ProviderId;
  model: string;
  propose(req: ProposalRequest): Promise<ProposalOutcome>;
}
