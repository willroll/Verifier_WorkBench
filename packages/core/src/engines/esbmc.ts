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

// ESBMC adapter. ESBMC prints its report as text on stderr.
//
// Harness: with `--function f` ESBMC never prints the values of f's
// parameters, so the counterexample would be empty. We append a generated
// wrapper per function (after the user's code, so line numbers are unchanged)
// that declares the parameters as locals initialized from body-less functions.
// Both engines treat those as arbitrary values, and ESBMC prints them.
// Parameter types come from ESBMC's own symbol table. If the wrapper does not
// compile, we fall back to plain `--function f` (verdicts, but no inputs).

const HARNESS_PREFIX = '__vw_h_';
const LIST_STUB = '__vw_list';

export function esbmcCheckArgs(checks: CheckId[]): string[] {
  const has = (c: CheckId) => checks.includes(c);
  const args: string[] = [];
  // Bounds, pointer and division checks are on by default in ESBMC.
  if (!has('bounds')) args.push('--no-bounds-check');
  if (!has('pointer')) args.push('--no-pointer-check');
  if (!has('div-by-zero')) args.push('--no-div-by-zero-check');
  if (has('signed-overflow')) args.push('--overflow-check');
  if (has('unsigned-overflow')) args.push('--unsigned-overflow-check');
  if (has('undefined-shift')) args.push('--ub-shift-check');
  return args;
}

const SOLVER_FLAGS: Partial<Record<SolverId, string>> = {
  bitwuzla: '--bitwuzla',
  z3: '--z3',
  cvc5: '--cvc5',
  boolector: '--boolector',
};

export function esbmcSolverArgs(solver: SolverId): string[] {
  const flag = SOLVER_FLAGS[solver];
  if (!flag) throw new EngineError(`ESBMC cannot use the ${solver} solver`);
  return [flag];
}

const bound = (ctx: RunContext) => ['--unwind', String(ctx.unwind)]; // unwinding assertions are on by default

export const esbmcArgs = {
  symbolTable: (ctx: RunContext) => [
    ctx.fileName,
    '--function',
    LIST_STUB,
    '--symbol-table-only',
    ...ctx.config.extraFlags.esbmc,
  ],
  claims: (ctx: RunContext, entry: string) => [
    ctx.fileName,
    '--function',
    entry,
    '--show-claims',
    ...esbmcCheckArgs(ctx.checks),
    ...bound(ctx),
    ...ctx.config.extraFlags.esbmc,
  ],
  verify: (ctx: RunContext, entry: string) => [
    ctx.fileName,
    '--function',
    entry,
    '--multi-property',
    ...esbmcCheckArgs(ctx.checks),
    ...bound(ctx),
    ...esbmcSolverArgs(ctx.solver),
    ...ctx.config.extraFlags.esbmc,
  ],
  exportSmt: (ctx: RunContext, entry: string, claim: number, outFile: string) => [
    ctx.fileName,
    '--function',
    entry,
    '--claim',
    String(claim),
    '--smt-formula-only',
    '--output',
    outFile,
    ...esbmcCheckArgs(ctx.checks),
    ...bound(ctx),
    // The formula is printed through Z3's SMT-LIB printer whatever solver verified it.
    '--z3',
    ...ctx.config.extraFlags.esbmc,
  ],
};

// ---- Symbol table -> functions and parameter types -------------------------

export interface EsbmcSymbol {
  symbol: string;
  type: string;
  value: string;
  location: string;
}

export function parseSymbolTable(text: string): EsbmcSymbol[] {
  const out: EsbmcSymbol[] = [];
  let cur: EsbmcSymbol | null = null;
  let inValue = false;
  for (const line of text.split('\n')) {
    const field = /^(Symbol|Module|Base name|Mode|Type|Value|Flags|Location)\.+: ?(.*)$/.exec(line);
    if (field) {
      const key = field[1]!;
      const val = field[2] ?? '';
      if (key === 'Symbol') {
        cur = { symbol: val.trim(), type: '', value: '', location: '' };
        out.push(cur);
      } else if (cur) {
        if (key === 'Type') cur.type = val.trim();
        else if (key === 'Value') cur.value = val;
        else if (key === 'Location') cur.location = val.trim();
      }
      inValue = key === 'Value';
    } else if (cur && inValue) {
      cur.value += `\n${line}`;
    }
  }
  return out;
}

/** Splits "a, b (*)(c, d), e" at top-level commas. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

/** "signed int (signed int, signed int)" -> { ret: "signed int", params: ["signed int", "signed int"] } */
export function splitFunctionType(type: string): { ret: string; params: string[] } | null {
  const t = type.trim();
  if (!t.endsWith(')')) return null;
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0) {
      const ret = t.slice(0, i).trim();
      if (!ret || ret.includes('(')) return null;
      const params = splitTopLevel(t.slice(i + 1, -1)).filter((p) => p !== '...');
      return { ret, params: params.length === 1 && params[0] === 'void' ? [] : params };
    }
  }
  return null;
}

export interface EsbmcParam {
  type: string;
  /** Local variable name in the harness. */
  local: string;
  /** Name shown in the counterexample (the parameter's own name). */
  display: string;
}

export interface EsbmcFunction {
  name: string;
  line: number;
  /** Signature in ESBMC's canonical types, e.g. 'signed int avg(signed int a, signed int b)'. */
  signature?: string;
  /** ESBMC's function type, e.g. 'signed int (signed int, signed int)': canonical, without names. */
  typeKey: string;
  /** Null when the parameter types cannot be expressed in a harness. */
  params: EsbmcParam[] | null;
}

const locationOf = (loc: string) => /file (\S+) line (\d+)/.exec(loc);

export function esbmcFunctions(symbols: EsbmcSymbol[], fileName: string): EsbmcFunction[] {
  const fns: EsbmcFunction[] = [];
  for (const s of symbols) {
    const m = /^c:(?:[^@]*@)?F@([A-Za-z_]\w*)$/.exec(s.symbol);
    if (!m) continue;
    const name = m[1]!;
    const loc = locationOf(s.location);
    if (!loc || loc[1] !== fileName || !s.value.trim() || name.startsWith('__vw_')) continue;

    const sig = splitFunctionType(s.type);
    let params: EsbmcParam[] | null = null;
    if (sig && sig.params.every((p) => !p.includes('['))) {
      // Parameters and locals share one symbol pattern; parameters are declared
      // first, so the first N by source offset are the parameters.
      const declared = symbols
        .map((x) => new RegExp(`^c:[^@]*@(\\d+)@F@${name}@([A-Za-z_]\\w*)$`).exec(x.symbol))
        .filter((x): x is RegExpExecArray => x !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((x) => x[2]!);
      const used = new Set<string>();
      params = sig.params.map((type, i) => {
        const display = declared.length >= sig.params.length ? declared[i]! : `arg${i}`;
        const clash = display === name || display.startsWith('__vw_') || used.has(display);
        const local = clash ? `__vw_p${i}` : display;
        used.add(local);
        return { type, local, display };
      });
    }
    const fn: EsbmcFunction = {
      name,
      line: Number(loc[2]),
      params,
      typeKey: s.type.replace(/\s+/g, ' ').trim(),
    };
    if (sig) {
      const shown = params ? params.map((p) => `${p.type} ${p.display}`) : sig.params;
      fn.signature = `${sig.ret} ${name}(${shown.join(', ') || 'void'})`;
    }
    fns.push(fn);
  }
  return fns.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

export function esbmcHarness(fns: EsbmcFunction[]): string {
  const lines = [
    '',
    '/* ---- Verifier Workbench harness (generated; not part of the submitted source) ---- */',
  ];
  for (const f of fns) {
    if (!f.params) continue;
    const nd = (i: number) => `__vw_nd_${f.name}_${i}`;
    f.params.forEach((p, i) => lines.push(`__typeof__(${p.type}) ${nd(i)}(void);`));
    lines.push(`void ${HARNESS_PREFIX}${f.name}(void) {`);
    f.params.forEach((p, i) => lines.push(`  __typeof__(${p.type}) ${p.local} = ${nd(i)}();`));
    lines.push(`  (void)${f.name}(${f.params.map((p) => p.local).join(', ')});`, '}');
  }
  return `${lines.join('\n')}\n`;
}

// ---- Report parsing ----------------------------------------------------------

export function esbmcDiagnostics(text: string, fileName: string, userLines: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.line}|${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(d);
    }
  };
  for (const line of text.split('\n')) {
    const m = /^(\S+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/.exec(line);
    if (m) {
      const lineNo = Number(m[2]);
      // Warnings about the generated harness are ours, not the user's.
      if (m[1] === fileName && lineNo > userLines && m[4] === 'warning') continue;
      push({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        message: m[5]!,
        file: m[1]!,
        line: lineNo,
        column: Number(m[3]),
      });
      continue;
    }
    const e = /^ERROR: (.*)$/.exec(line);
    if (e) push({ severity: 'error', message: e[1]! });
  }
  return out;
}

export interface EsbmcClaim {
  number: number;
  file: string;
  line: number;
  function: string;
  message: string;
}

export function parseClaims(text: string): EsbmcClaim[] {
  const lines = text.split('\n');
  const claims: EsbmcClaim[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^Claim (\d+):\s*$/.exec(lines[i]!);
    if (!head) continue;
    const loc = /file (\S+) line (\d+)(?: column \d+)?(?: function (\S+))?/.exec(lines[i + 1] ?? '');
    claims.push({
      number: Number(head[1]),
      file: loc?.[1] ?? '',
      line: Number(loc?.[2] ?? 0),
      function: loc?.[3] ?? '',
      message: (lines[i + 2] ?? '').trim(),
    });
  }
  return claims;
}

export interface EsbmcResultEntry {
  status: string;
  id: string;
  line: number;
  function: string;
  file: string;
  message: string;
}

/** The "** Results:" block printed in --multi-property mode. */
export function parseResults(text: string): EsbmcResultEntry[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('** Results:'));
  if (start < 0) return [];
  const out: EsbmcResultEntry[] = [];
  let file = '';
  let fn = '';
  for (const line of lines.slice(start + 1)) {
    if (/^\*\* \d+ of \d+/.test(line) || line.startsWith('VERIFICATION')) break;
    const header = /^(\S.*?), function (\S+)\s*$/.exec(line);
    if (header) {
      file = header[1]!;
      fn = header[2]!;
      continue;
    }
    // Line numbers are right-aligned when any is wider ("line   5"), hence \s+.
    const entry =
      /^\s*(PASSED|FAILED|NOT CHECKED|UNKNOWN|ERROR|SKIPPED)\s+\[([^\]]+)\]\s+line\s+(\d+)\s+(.*?)\s*$/.exec(
        line,
      );
    if (entry) {
      out.push({
        status: entry[1]!,
        id: entry[2]!,
        line: Number(entry[3]),
        function: fn,
        file,
        message: entry[4]!,
      });
    }
  }
  return out;
}

export interface EsbmcCounterexample {
  states: { file: string; line: number; function: string; name: string; value: string; bits?: string }[];
  violated: { file: string; line: number; function: string; message: string };
}

export function parseCounterexamples(text: string): EsbmcCounterexample[] {
  const out: EsbmcCounterexample[] = [];
  for (const block of text.split('[Counterexample]').slice(1)) {
    const lines = block.split('\n');
    const states: EsbmcCounterexample['states'] = [];
    let where = { file: '', line: 0, function: '' };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const st = /^State \d+ file (\S+) line (\d+)(?: column \d+)?(?: function (\S+))?/.exec(l);
      if (st) {
        where = { file: st[1]!, line: Number(st[2]), function: st[3] ?? '' };
        continue;
      }
      if (l.startsWith('Violated property:')) {
        const loc = /file (\S+) line (\d+)(?: column \d+)?(?: function (\S+))?/.exec(lines[i + 1] ?? '');
        out.push({
          states,
          violated: {
            file: loc?.[1] ?? where.file,
            line: Number(loc?.[2] ?? where.line),
            function: loc?.[3] ?? where.function,
            message: (lines[i + 2] ?? '').trim(),
          },
        });
        break;
      }
      const asg = /^ {2}(\S.*?) = (.*)$/.exec(l);
      if (asg) {
        let value = asg[2]!.trim();
        let bits: string | undefined;
        const b = /\s*\(([01 ]+)\)$/.exec(value);
        if (b) {
          bits = b[1]!.replace(/\s/g, '');
          value = value.slice(0, b.index).trim();
        }
        states.push({ ...where, name: asg[1]!, value, ...(bits ? { bits } : {}) });
      }
    }
  }
  return out;
}

export function esbmcSolverSeen(text: string): SolverSeen | undefined {
  const s =
    /Solving with solver (\S+)\s+v?([\d.]+)?/.exec(text) ?? /^Solver: (\S+)\s+v?([\d.]+)?/m.exec(text);
  if (!s) return undefined;
  const enc = /Encoding remaining VCC\(s\) using (.+)$/m.exec(text);
  return {
    label: s[1]!,
    version: s[2] ?? null,
    encoding: `SMT (${enc?.[1]?.trim() ?? 'bit-vector arithmetic'})`,
  };
}

// ---- Interpreting one per-function run ------------------------------------

export function esbmcFindings(
  text: string,
  entry: string,
  userFunctions: ReadonlySet<string>,
  params: EsbmcParam[] | null,
  userLines: number,
): { findings: Finding[]; unwindIncomplete: boolean } {
  const results = parseResults(text);
  const kindOf = (r: EsbmcResultEntry) => classify(r.message, r.id);
  const unwindIncomplete = results.some((r) => kindOf(r) === 'unwind' && r.status === 'FAILED');

  const cex = new Map<string, EsbmcCounterexample[]>();
  for (const c of parseCounterexamples(text)) {
    const key = `${c.violated.function}|${c.violated.line}|${c.violated.message}`;
    cex.set(key, [...(cex.get(key) ?? []), c]);
  }
  const byLocal = new Map((params ?? []).map((p) => [p.local, p]));

  const findings: Finding[] = [];
  for (const r of results) {
    const own = r.function === entry;
    // ESBMC instruments its own runtime too (e.g. __ESBMC_pthread_*_main_hook); skip those like our harness.
    const internal = r.function.startsWith('__vw_') || r.function.startsWith('__ESBMC');
    const library = r.function !== '' && !userFunctions.has(r.function) && !internal;
    if (!own && !(library && r.status !== 'PASSED')) continue;

    const kind = kindOf(r);
    let status: ObligationStatus;
    let reason: InconclusiveReason | undefined;
    if (r.status === 'PASSED') {
      status = unwindIncomplete ? 'inconclusive' : 'proved';
      if (unwindIncomplete) reason = 'unwind-bound';
    } else if (r.status === 'FAILED') {
      status = kind === 'unwind' ? 'inconclusive' : 'refuted';
      if (kind === 'unwind') reason = 'unwind-bound';
    } else {
      status = 'inconclusive';
      reason =
        r.status === 'NOT CHECKED' || r.status === 'SKIPPED'
          ? 'not-checked'
          : r.status === 'ERROR'
            ? 'error'
            : 'unknown';
    }

    const finding: Finding = {
      id: r.id,
      status,
      kind,
      message: r.message,
      file: r.file,
      line: r.line,
      function: r.function,
      entry,
      model: [],
      trace: [],
    };
    if (reason) finding.reason = reason;

    if (status === 'refuted') {
      const c = cex.get(`${r.function}|${r.line}|${r.message}`)?.shift();
      if (c) {
        const inputs: WitnessValue[] = [];
        const state = new Map<string, WitnessValue>();
        const trace: TraceStep[] = [];
        for (const s of c.states) {
          const harness = s.function.startsWith(HARNESS_PREFIX);
          if (s.name.startsWith('__vw_') || s.name.startsWith('__ESBMC')) continue;
          const w: WitnessValue = { name: s.name, value: s.value, role: harness ? 'input' : 'state' };
          const hex = bitsToHex(s.bits);
          if (hex) {
            w.hex = hex;
            w.width = s.bits!.length;
          }
          if (harness) {
            const param = byLocal.get(s.name);
            if (param) {
              w.name = param.display;
              w.type = param.type;
            }
            inputs.push(w);
          } else {
            if (s.function && s.function !== entry) w.name = `${s.function}::${s.name}`;
            state.delete(w.name);
            state.set(w.name, w);
          }
          if (!harness && s.line > 0 && s.line <= userLines) {
            trace.push({ file: s.file, line: s.line, function: s.function, text: `${s.name} = ${s.value}` });
          }
        }
        trace.push({ file: r.file, line: r.line, function: r.function, text: `violated: ${r.message}` });
        finding.model = [...inputs, ...[...state.values()].slice(-12)];
        finding.trace = trace;
      }
    }
    findings.push(finding);
  }
  return { findings, unwindIncomplete };
}

// ---- Adapter -----------------------------------------------------------------

async function run(ctx: RunContext, args: string[]): Promise<RunResult & { text: string }> {
  ctx.log.push(`$ esbmc ${args.join(' ')}`);
  const res = await ctx.runner.run(ctx.config.bins.esbmc, args, {
    cwd: ctx.dir,
    timeoutMs: ctx.config.timeoutMs,
    maxOutputBytes: ctx.config.maxOutputBytes,
    memoryLimitMb: ctx.config.memoryLimitMb,
  });
  if (res.spawnError) throw new EngineError(`could not start ESBMC: ${res.spawnError}`);
  return { ...res, text: `${res.stdout}\n${res.stderr}` };
}

function logReport(ctx: RunContext, text: string) {
  const keep = text
    .split('\n')
    .filter((l) => /^(\*\*|VERIFICATION|ERROR|Solver:|Solving with|\s+(PASSED|FAILED|NOT CHECKED))/.test(l));
  ctx.log.push(...keep.map((l) => `  ${l.trim()}`));
}

interface EsbmcExtra {
  userFunctions: Set<string>;
  fns: Map<string, EsbmcFunction>;
  /** Whether the generated wrapper compiled; without it runs use plain --function. */
  harness: boolean;
}

const userLineCount = (code: string) => code.split('\n').length;

export const esbmc: EngineAdapter = {
  id: 'esbmc',
  label: 'ESBMC',

  async analyze(ctx) {
    const file = path.join(ctx.dir, ctx.fileName);
    const userLines = userLineCount(ctx.code);

    await fs.writeFile(file, `${ctx.code}\n\nvoid ${LIST_STUB}(void) {}\n`);
    const st = await run(ctx, esbmcArgs.symbolTable(ctx));
    const diagnostics = esbmcDiagnostics(st.text, ctx.fileName, userLines);
    const firstError = diagnostics.find((d) => d.severity === 'error');
    if (firstError || !st.text.includes('Symbol......:')) {
      logReport(ctx, st.text);
      return {
        functions: [],
        diagnostics,
        error: firstError
          ? `the source does not compile: ${firstError.line ? `line ${firstError.line}: ` : ''}${firstError.message}`
          : st.timedOut
            ? 'timed out while reading the source'
            : 'ESBMC could not read the source',
      };
    }

    const fns = esbmcFunctions(parseSymbolTable(st.text), ctx.fileName);
    const firstFn = fns[0];
    if (!firstFn)
      return {
        functions: [],
        diagnostics,
        extra: { userFunctions: new Set(), fns: new Map(), harness: false },
      };

    // Try the generated wrapper; fall back to plain --function if it does not compile.
    let harness = fns.some((f) => f.params !== null);
    let claimsRun: Awaited<ReturnType<typeof run>> | null = null;
    if (harness) {
      await fs.writeFile(file, ctx.code + esbmcHarness(fns));
      const entryFn = fns.find((f) => f.params !== null)!;
      claimsRun = await run(ctx, esbmcArgs.claims(ctx, HARNESS_PREFIX + entryFn.name));
      if (esbmcDiagnostics(claimsRun.text, ctx.fileName, userLines).some((d) => d.severity === 'error')) {
        ctx.log.push(
          '  generated harness did not compile; verifying with plain --function (no input values)',
        );
        harness = false;
        claimsRun = null;
      }
    }
    if (!harness) {
      await fs.writeFile(file, ctx.code);
      claimsRun = await run(ctx, esbmcArgs.claims(ctx, firstFn.name));
    }

    const byName = new Map<string, FunctionInfo>(
      fns.map((f) => [
        f.name,
        {
          name: f.name,
          line: f.line,
          obligations: [] as Obligation[],
          typeKey: f.typeKey,
          ...(f.signature ? { signature: f.signature } : {}),
        },
      ]),
    );
    for (const c of parseClaims(claimsRun!.text)) {
      byName.get(c.function)?.obligations.push({
        id: `claim ${c.number}`,
        function: c.function,
        line: c.line,
        message: c.message,
        exportRef: `claim:${c.number}`,
      });
    }
    const extra: EsbmcExtra = {
      userFunctions: new Set(fns.map((f) => f.name)),
      fns: new Map(fns.map((f) => [f.name, f])),
      harness,
    };
    return { functions: [...byName.values()], diagnostics, extra };
  },

  async verifyFunction(ctx, fn, analysis): Promise<FunctionRun> {
    const extra = analysis.extra as EsbmcExtra;
    const info = extra.fns.get(fn.name);
    const wrapped = extra.harness && info?.params != null;
    const res = await run(ctx, esbmcArgs.verify(ctx, wrapped ? HARNESS_PREFIX + fn.name : fn.name));
    logReport(ctx, res.text);
    if (res.timedOut || res.truncated) {
      return {
        findings: [],
        durationMs: res.durationMs,
        unwindIncomplete: false,
        timedOut: res.timedOut,
        error: res.timedOut
          ? `timed out after ${Math.round(res.durationMs / 1000)} s`
          : 'output exceeded the size limit',
      };
    }
    if (!res.text.includes('** Results:') && !/VERIFICATION (SUCCESSFUL|FAILED)/.test(res.text)) {
      const err = esbmcDiagnostics(res.text, ctx.fileName, userLineCount(ctx.code)).find(
        (d) => d.severity === 'error',
      );
      return {
        findings: [],
        durationMs: res.durationMs,
        unwindIncomplete: false,
        error: err?.message ?? 'could not parse ESBMC output',
      };
    }
    const { findings, unwindIncomplete } = esbmcFindings(
      res.text,
      fn.name,
      extra.userFunctions,
      wrapped ? (info?.params ?? null) : null,
      userLineCount(ctx.code),
    );
    // Claim numbers come from --show-claims; attach them for SMT-LIB export.
    const claims = new Map<string, Obligation[]>();
    for (const ob of fn.obligations) {
      const key = `${ob.line}|${ob.message}`;
      claims.set(key, [...(claims.get(key) ?? []), ob]);
    }
    for (const f of findings) {
      if (f.kind === 'unwind' || f.function !== fn.name) continue;
      const ob = claims.get(`${f.line}|${f.message}`)?.shift();
      if (ob?.exportRef) f.exportRef = ob.exportRef;
    }
    const out: FunctionRun = { findings, durationMs: res.durationMs, unwindIncomplete };
    const seen = esbmcSolverSeen(res.text);
    if (seen) out.solverSeen = seen;
    return out;
  },

  async exportSmt(ctx, entry, ref, analysis) {
    const m = /^claim:(\d+)$/.exec(ref);
    if (!m) throw new EngineError(`not an ESBMC export reference: ${ref}`);
    const extra = analysis.extra as EsbmcExtra;
    const info = extra.fns.get(entry);
    const wrapped = extra.harness && info?.params != null;
    const outFile = 'export.smt2';
    const res = await run(
      ctx,
      esbmcArgs.exportSmt(ctx, wrapped ? HARNESS_PREFIX + entry : entry, Number(m[1]), outFile),
    );
    const text = await fs.readFile(path.join(ctx.dir, outFile), 'utf8').catch(() => null);
    if (text === null || !text.trim()) {
      const err = esbmcDiagnostics(res.text, ctx.fileName, userLineCount(ctx.code)).find(
        (d) => d.severity === 'error',
      );
      throw new EngineError(err?.message ?? 'ESBMC wrote no SMT-LIB formula');
    }
    return text;
  },
};
