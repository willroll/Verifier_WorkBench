import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CheckId,
  Diagnostic,
  Finding,
  InconclusiveReason,
  ObligationStatus,
  SolverId,
  TraceStep,
  WitnessValue,
} from '@verifier/shared';
import { bitsToHex, classify } from '../classify';
import type { RunResult } from '../runner';
import {
  EngineError,
  type EngineAdapter,
  type FunctionInfo,
  type FunctionRun,
  type Obligation,
  type RunContext,
  type SolverSeen,
} from './types';

// CBMC adapter. CBMC's --json-ui output is structured, so everything here is
// parsed from JSON: the symbol table (functions and signatures), the property
// list (obligations), and per-function results with counterexample traces.
//
// Harness: one run per function with `--function f`, which gives f's
// parameters arbitrary values. A run also reports properties of functions f
// never reaches, as vacuous SUCCESS, so only f's own properties are kept
// (plus failures inside library code such as memcpy that f reaches).

const CHECK_FLAGS: Record<CheckId, string> = {
  bounds: '--bounds-check',
  pointer: '--pointer-check',
  'div-by-zero': '--div-by-zero-check',
  'signed-overflow': '--signed-overflow-check',
  'unsigned-overflow': '--unsigned-overflow-check',
  conversion: '--conversion-check',
  'undefined-shift': '--undefined-shift-check',
};

// MiniSAT is built in (no flag); SMT back ends run as external binaries.
const SOLVER_FLAGS: Partial<Record<SolverId, string>> = {
  z3: '--z3',
  cvc5: '--cvc5',
  bitwuzla: '--bitwuzla',
};

export function cbmcSolverArgs(solver: SolverId): string[] {
  if (solver === 'minisat') return [];
  const flag = SOLVER_FLAGS[solver];
  if (!flag) throw new EngineError(`CBMC cannot use the ${solver} solver`);
  return [flag];
}

const checkArgs = (checks: CheckId[]) => checks.map((c) => CHECK_FLAGS[c]);
const bound = (ctx: RunContext) => ['--unwind', String(ctx.unwind), '--unwinding-assertions'];

export const cbmcArgs = {
  symbolTable: (ctx: RunContext) => [
    ctx.fileName,
    '--show-symbol-table',
    '--json-ui',
    ...ctx.config.extraFlags.cbmc,
  ],
  properties: (ctx: RunContext) => [
    ctx.fileName,
    '--show-properties',
    '--json-ui',
    ...checkArgs(ctx.checks),
    ...ctx.config.extraFlags.cbmc,
  ],
  verify: (ctx: RunContext, fn: string) => [
    ctx.fileName,
    '--function',
    fn,
    '--json-ui',
    ...checkArgs(ctx.checks),
    ...bound(ctx),
    ...cbmcSolverArgs(ctx.solver),
    ...ctx.config.extraFlags.cbmc,
  ],
  exportSmt: (ctx: RunContext, fn: string, property: string, outFile: string) => [
    ctx.fileName,
    '--function',
    fn,
    '--property',
    property,
    '--json-ui',
    ...checkArgs(ctx.checks),
    ...bound(ctx),
    '--smt2',
    '--outfile',
    outFile,
    ...ctx.config.extraFlags.cbmc,
  ],
};

// ---- JSON-UI shapes (only the fields we read) ------------------------------

interface CbmcLocation {
  file?: string;
  function?: string;
  line?: string | number;
  column?: string | number;
}
interface CbmcValue {
  data?: string;
  name?: string;
  binary?: string;
  type?: string;
  width?: number;
  members?: { name?: string; value?: CbmcValue }[];
  elements?: { index?: number; value?: CbmcValue }[];
}
interface CbmcStep {
  stepType?: string;
  hidden?: boolean;
  assignmentType?: string;
  lhs?: string;
  value?: CbmcValue;
  sourceLocation?: CbmcLocation;
  function?: { identifier?: string; displayName?: string };
  reason?: string;
}
interface CbmcResult {
  property?: string;
  description?: string;
  status?: string;
  sourceLocation?: CbmcLocation;
  trace?: CbmcStep[];
}
interface CbmcProperty {
  name?: string;
  description?: string;
  sourceLocation?: CbmcLocation;
}
interface CbmcIrep {
  id?: string;
  namedSub?: Record<string, CbmcIrep>;
}
interface CbmcSymbol {
  name?: string;
  prettyType?: string;
  mode?: string;
  isType?: boolean;
  type?: CbmcIrep;
  value?: CbmcIrep;
  location?: CbmcIrep;
}
export interface CbmcMessage {
  program?: string;
  messageType?: string;
  messageText?: string;
  sourceLocation?: CbmcLocation;
  result?: CbmcResult[];
  properties?: CbmcProperty[];
  symbolTable?: Record<string, CbmcSymbol>;
}

/** Parses --json-ui output; tolerates the unterminated array a killed run leaves. */
export function parseJsonUi(text: string): CbmcMessage[] | null {
  const t = text.trim();
  if (!t) return null;
  for (const candidate of [t, t.replace(/,\s*$/, '') + ']']) {
    try {
      const v: unknown = JSON.parse(candidate);
      if (Array.isArray(v)) return v as CbmcMessage[];
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function cbmcDiagnostics(msgs: CbmcMessage[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.messageType !== 'ERROR' && m.messageType !== 'WARNING') continue;
    const message = (m.messageText ?? '').trim();
    if (!message || /--unwinding-assertions to obtain sound/.test(message)) continue;
    const d: Diagnostic = { severity: m.messageType === 'ERROR' ? 'error' : 'warning', message };
    const loc = m.sourceLocation;
    if (loc?.file) d.file = loc.file;
    if (loc?.line) d.line = Number(loc.line);
    if (loc?.column) d.column = Number(loc.column);
    const key = `${d.severity}|${d.file}|${d.line}|${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

const irep = (node: CbmcIrep | undefined, field: string) => node?.namedSub?.[field]?.id;

/** "int32_t (int32_t a, int32_t b)" + "avg" -> "int32_t avg(int32_t a, int32_t b)" */
export function signatureFrom(prettyType: string | undefined, name: string): string | undefined {
  const t = prettyType?.trim();
  if (!t?.endsWith(')')) return undefined;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0) {
      const ret = t.slice(0, i).trim();
      if (!ret || ret.includes('(')) return undefined;
      return `${ret} ${name}${t.slice(i)}`;
    }
  }
  return undefined;
}

/** Functions with a body in the submitted file, in source order. */
export function cbmcFunctions(msgs: CbmcMessage[], fileName: string): FunctionInfo[] {
  const table = msgs.find((m) => m.symbolTable)?.symbolTable ?? {};
  const fns: FunctionInfo[] = [];
  for (const sym of Object.values(table)) {
    if (sym.type?.id !== 'code' || sym.isType || !sym.name) continue;
    if (irep(sym.location, 'file') !== fileName) continue;
    if (!sym.value?.id || sym.value.id === 'nil') continue;
    const info: FunctionInfo = {
      name: sym.name,
      line: Number(irep(sym.location, 'line') ?? 0),
      obligations: [],
    };
    const signature = signatureFrom(sym.prettyType, sym.name);
    if (signature) info.signature = signature;
    fns.push(info);
  }
  return fns.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

export function cbmcObligations(msgs: CbmcMessage[]): Obligation[] {
  const props = msgs.find((m) => Array.isArray(m.properties))?.properties ?? [];
  return props
    .filter((p) => p.name)
    .map((p) => ({
      id: p.name!,
      function: p.sourceLocation?.function ?? '',
      line: Number(p.sourceLocation?.line ?? 0),
      message: p.description ?? '',
      exportRef: `property:${p.name!}`,
    }));
}

export function cbmcSolverSeen(msgs: CbmcMessage[]): SolverSeen | undefined {
  for (const m of msgs) {
    const t = m.messageText ?? '';
    const sat = /^Solving with (\S+)\s+([\d.]+)?/.exec(t);
    if (sat) return { label: sat[1]!, version: sat[2] ?? null, encoding: 'SAT (bit-blasted)' };
    const smt = /^Passing problem to SMT2 (.+?) using (\S+)/.exec(t);
    if (smt) return { label: smt[2]!, version: null, encoding: `SMT-LIB ${smt[1]!}` };
  }
  return undefined;
}

// ---- Counterexamples ---------------------------------------------------------

function formatValue(v: CbmcValue | undefined, depth = 0): string {
  if (!v) return '?';
  // CBMC prints integers as C literals ("14ul"); the type is reported separately.
  if (v.data !== undefined) return v.data.replace(/^(-?\d+)(?:[uU]?[lL]{0,2}|[lL]{1,2}[uU])$/, '$1');
  if (depth < 2 && Array.isArray(v.members)) {
    return `{ ${v.members.map((m) => `${m.name ?? '?'}=${formatValue(m.value, depth + 1)}`).join(', ')} }`;
  }
  if (depth < 2 && Array.isArray(v.elements)) {
    const shown = v.elements.slice(0, 8).map((e) => formatValue(e.value, depth + 1));
    return `[${shown.join(', ')}${v.elements.length > 8 ? ', …' : ''}]`;
  }
  return v.name ?? '?';
}

function witness(step: CbmcStep, role: WitnessValue['role'], name: string): WitnessValue {
  const w: WitnessValue = { name, value: formatValue(step.value), role };
  if (step.value?.type) w.type = step.value.type;
  if (typeof step.value?.width === 'number') w.width = step.value.width;
  const hex = bitsToHex(step.value?.binary);
  if (hex) w.hex = hex;
  return w;
}

/**
 * Inputs are the entry function's actual parameters (the assignments right
 * after the harness calls it). State is the last value of each variable
 * assigned afterwards on the failing path. Static initialization (inside
 * __CPROVER_initialize) is skipped: it is the same for every run and used to
 * crowd out the real witness.
 */
export function cbmcWitness(trace: CbmcStep[], entry: string, maxState = 12): WitnessValue[] {
  const call = trace.findIndex((s) => s.stepType === 'function-call' && s.function?.identifier === entry);
  if (call < 0) return [];
  const inputs: WitnessValue[] = [];
  let i = call + 1;
  for (; i < trace.length; i++) {
    const s = trace[i]!;
    if (s.stepType !== 'assignment' || s.assignmentType !== 'actual-parameter' || !s.lhs) break;
    inputs.push(witness(s, 'input', s.lhs));
  }
  const state = new Map<string, WitnessValue>();
  let callee: string | null = null;
  for (; i < trace.length; i++) {
    const s = trace[i]!;
    if (s.stepType === 'function-call') {
      callee = s.function?.identifier ?? null;
      continue;
    }
    if (s.stepType !== 'assignment' || s.hidden || !s.lhs) continue;
    if (s.lhs.startsWith('__CPROVER') || s.lhs.includes('#')) continue;
    const scope = s.assignmentType === 'actual-parameter' ? callee : s.sourceLocation?.function;
    const name = scope && scope !== entry ? `${scope}::${s.lhs}` : s.lhs;
    state.delete(name);
    state.set(name, witness(s, 'state', name));
  }
  // An array assigned whole is also reported element by element; keep the whole.
  const values = [...state.values()].filter((w) => {
    const element = /^(.+)\[\d+l?\]$/.exec(w.name);
    return !(element && state.has(element[1]!));
  });
  return [...inputs, ...values.slice(-maxState)];
}

export function cbmcTraceSteps(trace: CbmcStep[], entry: string, max = 200): TraceStep[] {
  const call = trace.findIndex((s) => s.stepType === 'function-call' && s.function?.identifier === entry);
  const steps: TraceStep[] = [];
  for (const s of trace.slice(Math.max(0, call))) {
    const loc = s.sourceLocation;
    if (s.hidden || !loc?.line) continue;
    let text: string;
    switch (s.stepType) {
      case 'assignment':
        text = `${s.lhs ?? '?'} = ${formatValue(s.value)}`;
        break;
      case 'function-call':
        text = `call ${s.function?.displayName ?? s.function?.identifier ?? '?'}`;
        break;
      case 'function-return':
        text = `return from ${s.function?.displayName ?? s.function?.identifier ?? '?'}`;
        break;
      case 'failure':
        text = `violated: ${s.reason ?? ''}`;
        break;
      default:
        text = '';
    }
    steps.push({ file: loc.file ?? '', line: Number(loc.line), function: loc.function ?? '', text });
    if (steps.length >= max) break;
  }
  return steps;
}

// ---- Interpreting one per-function run ------------------------------------

export function cbmcFindings(
  msgs: CbmcMessage[],
  entry: string,
  userFunctions: ReadonlySet<string>,
): { findings: Finding[]; unwindIncomplete: boolean } {
  const results = msgs.find((m) => Array.isArray(m.result))?.result ?? [];
  const kindOf = (r: CbmcResult) => classify(r.description ?? '', r.property ?? '');
  // Any failed unwinding assertion means some paths were cut at the bound,
  // so nothing checked from this entry is fully proved.
  const unwindIncomplete = results.some((r) => kindOf(r) === 'unwind' && r.status === 'FAILURE');

  const findings: Finding[] = [];
  for (const r of results) {
    const owner = r.sourceLocation?.function ?? '';
    const own = owner === entry;
    const library = owner !== '' && !userFunctions.has(owner) && !owner.startsWith('__CPROVER');
    // Library SUCCESS may be vacuous (never reached from this entry), so only its failures count.
    if (!own && !(library && r.status !== 'SUCCESS')) continue;

    const id = r.property ?? `${owner}.unnamed`;
    const kind = kindOf(r);
    let status: ObligationStatus;
    let reason: InconclusiveReason | undefined;
    if (r.status === 'SUCCESS') {
      status = unwindIncomplete ? 'inconclusive' : 'proved';
      if (unwindIncomplete) reason = 'unwind-bound';
    } else if (r.status === 'FAILURE') {
      status = kind === 'unwind' ? 'inconclusive' : 'refuted';
      if (kind === 'unwind') reason = 'unwind-bound';
    } else {
      status = 'inconclusive';
      reason = r.status === 'ERROR' ? 'error' : 'unknown';
    }

    const finding: Finding = {
      id,
      status,
      kind,
      message: r.description ?? '',
      file: r.sourceLocation?.file ?? '',
      line: Number(r.sourceLocation?.line ?? 0),
      function: owner || entry,
      entry,
      model: [],
      trace: [],
    };
    if (reason) finding.reason = reason;
    if (kind !== 'unwind') finding.exportRef = `property:${id}`;
    if (status === 'refuted' && r.trace) {
      finding.model = cbmcWitness(r.trace, entry);
      finding.trace = cbmcTraceSteps(r.trace, entry);
    }
    findings.push(finding);
  }
  return { findings, unwindIncomplete };
}

// ---- Adapter -----------------------------------------------------------------

async function run(ctx: RunContext, args: string[]): Promise<RunResult> {
  ctx.log.push(`$ cbmc ${args.join(' ')}`);
  const res = await ctx.runner.run(ctx.config.bins.cbmc, args, {
    cwd: ctx.dir,
    timeoutMs: ctx.config.timeoutMs,
    maxOutputBytes: ctx.config.maxOutputBytes,
    memoryLimitMb: ctx.config.memoryLimitMb,
  });
  if (res.spawnError) throw new EngineError(`could not start CBMC: ${res.spawnError}`);
  return res;
}

function logMessages(ctx: RunContext, msgs: CbmcMessage[]) {
  for (const m of msgs) if (m.messageText) ctx.log.push(`  ${m.messageText}`);
}

const outputProblem = (res: RunResult) =>
  res.timedOut
    ? `timed out after ${Math.round(res.durationMs / 1000)} s`
    : res.truncated
      ? 'output exceeded the size limit'
      : `could not parse CBMC output${res.stderr.trim() ? `: ${res.stderr.trim().split('\n')[0]}` : ''}`;

interface CbmcExtra {
  userFunctions: Set<string>;
}

export const cbmc: EngineAdapter = {
  id: 'cbmc',
  label: 'CBMC',

  async analyze(ctx) {
    const [st, props] = await Promise.all([
      run(ctx, cbmcArgs.symbolTable(ctx)),
      run(ctx, cbmcArgs.properties(ctx)),
    ]);
    const stMsgs = parseJsonUi(st.stdout);
    const propMsgs = parseJsonUi(props.stdout);
    if (!stMsgs || !propMsgs) {
      return { functions: [], diagnostics: [], error: outputProblem(stMsgs ? props : st) };
    }
    const diagnostics = cbmcDiagnostics(stMsgs);
    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    if (hasErrors || !stMsgs.some((m) => m.symbolTable)) {
      logMessages(ctx, stMsgs);
      const first = diagnostics.find((d) => d.severity === 'error');
      return {
        functions: [],
        diagnostics,
        error: first
          ? `the source does not compile: ${first.line ? `line ${first.line}: ` : ''}${first.message}`
          : 'CBMC could not read the source',
      };
    }

    const functions = cbmcFunctions(stMsgs, ctx.fileName);
    const byName = new Map(functions.map((f) => [f.name, f]));
    for (const ob of cbmcObligations(propMsgs)) byName.get(ob.function)?.obligations.push(ob);
    const extra: CbmcExtra = { userFunctions: new Set(byName.keys()) };
    return { functions, diagnostics, extra };
  },

  async verifyFunction(ctx, fn, analysis): Promise<FunctionRun> {
    const { userFunctions } = analysis.extra as CbmcExtra;
    const res = await run(ctx, cbmcArgs.verify(ctx, fn.name));
    const msgs = parseJsonUi(res.stdout);
    const hasResults = msgs?.some((m) => Array.isArray(m.result)) ?? false;
    if (msgs)
      logMessages(
        ctx,
        msgs.filter((m) => !m.result),
      );
    if (!msgs || !hasResults) {
      const errors = msgs ? cbmcDiagnostics(msgs).filter((d) => d.severity === 'error') : [];
      return {
        findings: [],
        durationMs: res.durationMs,
        unwindIncomplete: false,
        timedOut: res.timedOut,
        error: errors[0]?.message ?? outputProblem(res),
      };
    }
    const { findings, unwindIncomplete } = cbmcFindings(msgs, fn.name, userFunctions);
    const run_: FunctionRun = { findings, durationMs: res.durationMs, unwindIncomplete };
    const seen = cbmcSolverSeen(msgs);
    if (seen) run_.solverSeen = seen;
    return run_;
  },

  async exportSmt(ctx, entry, ref) {
    const m = /^property:([\w$.:-]+)$/.exec(ref);
    if (!m) throw new EngineError(`not a CBMC export reference: ${ref}`);
    const outFile = 'export.smt2';
    const res = await run(ctx, cbmcArgs.exportSmt(ctx, entry, m[1]!, outFile));
    const text = await fs.readFile(path.join(ctx.dir, outFile), 'utf8').catch(() => null);
    if (text === null || !text.trim()) {
      const msgs = parseJsonUi(res.stdout) ?? [];
      const err = cbmcDiagnostics(msgs).find((d) => d.severity === 'error');
      throw new EngineError(err?.message ?? `CBMC wrote no SMT-LIB formula (${outputProblem(res)})`);
    }
    return text;
  },
};
