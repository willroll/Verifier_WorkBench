import fs from 'node:fs/promises';
import path from 'node:path';
import type { CheckId, EquivalenceResult, Rejection, SolverId, WitnessValue } from '@verifier/shared';
import { bitsToHex } from '../classify';
import type { CoreConfig } from '../config';
import type { EngineDetector } from '../detect';
import {
  canonicalType,
  cbmcDiagnostics,
  cbmcSolverArgs,
  irep,
  formatValue,
  parseJsonUi,
  type CbmcIrep,
  type CbmcMessage,
  type CbmcValue,
} from '../engines/cbmc';
import type { RunResult, Runner } from '../runner';
import { withWorkspace } from '../source';

// Behavior preservation, proved rather than tested. The original and the
// candidate are compiled side by side (every user function and global renamed
// with a per-version prefix) and CBMC checks, for each changed function f:
//
//     for all inputs x:  original(x) has no undefined behavior
//                        =>  candidate(x) == original(x)   (return value and globals)
//
// "Has no undefined behavior" is encoded by turning the original's safety
// checks into assumptions (goto-instrument --assert-to-assume in the same pass
// as the check flags) and its own asserts too (compiled against an assert.h
// that assumes), so the candidate may differ exactly where the original was
// undefined or failed an assertion, which is what a fix changes. Ending the
// program (abort, exit) where the original returns counts as a difference;
// CBMC would otherwise treat it as a path that simply stops. Nothing submitted
// is ever executed. A difference comes back as concrete inputs.

const SCALAR_TYPES = new Set([
  'signedbv',
  'unsignedbv',
  'c_bool',
  'bool',
  'floatbv',
  'fixedbv',
  'c_enum_tag',
  'c_enum',
]);
const PREFIX_ORIGINAL = '__vw_o_';
const PREFIX_CANDIDATE = '__vw_c_';
const ASSERT_TAG = 'vw-equivalence';
const USES = '__vw_uses';
const PHASE = '__vw_phase';

// The original's assertions become assumptions: its own asserts mark inputs
// where it is already wrong, like undefined behavior does.
const ASSUMING_ASSERT_H = [
  '/* Verifier Workbench behavior check: assertions of the original become assumptions. */',
  '#undef assert',
  '#define assert(e) __CPROVER_assume(e)',
  '',
].join('\n');
const ORIGINAL_PRELUDE = [
  '#define assert(e) __CPROVER_assume(e)',
  '#define __CPROVER_assert(c, d) __CPROVER_assume(c)',
];

const TERMINATORS = ['abort', 'exit', '_Exit', 'quick_exit'];

// Library functions that end the program. CBMC models them as a path that
// stops, which would make "abort on the inputs I cannot handle" look
// equivalent; here the candidate calling one is a difference.
const TERMINATION_TU = [
  '/* Verifier Workbench behavior check: termination (generated). */',
  `int ${PHASE};`,
  ...TERMINATORS.map(
    (name) =>
      `void ${name}(${name === 'abort' ? 'void' : 'int status'}) { __CPROVER_assert(${PHASE} != 2, "${ASSERT_TAG}: termination"); __CPROVER_assume(0); }`,
  ),
  '',
].join('\n');

const CHECK_FLAGS: Record<CheckId, string> = {
  bounds: '--bounds-check',
  pointer: '--pointer-check',
  'div-by-zero': '--div-by-zero-check',
  'signed-overflow': '--signed-overflow-check',
  'unsigned-overflow': '--unsigned-overflow-check',
  conversion: '--conversion-check',
  'undefined-shift': '--undefined-shift-check',
};

interface EqParam {
  name: string;
  /** C type text usable in a declaration, e.g. 'int32_t' or 'enum color'. */
  declType: string;
  scalar: boolean;
}

export interface EqFunction {
  name: string;
  line: number;
  typeKey: string;
  params: EqParam[];
  returns: 'void' | 'scalar' | 'float' | 'other';
  /** CBMC's re-printed body: formatting and comments do not affect it. */
  body: string;
  callees: string[];
  /** Functions this one calls that are declared in the file but have no body (their results are arbitrary). */
  undefinedCalls: string[];
  variadic: boolean;
}

export interface EqGlobal {
  name: string;
  typeKey: string;
  /** How it is compared: as a scalar, as a float (NaN-aware), element by element, or not at all. */
  kind: 'scalar' | 'float' | 'array' | 'other';
  /** For arrays: the number of dimensions and how the elements compare. */
  dims?: number;
  element?: 'scalar' | 'float';
  initializer: string;
}

export interface EqProgram {
  functions: Map<string, EqFunction>;
  globals: Map<string, EqGlobal>;
}

function splitParams(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

/** "int32_t (int32_t a, int32_t b)" -> ["int32_t a", "int32_t b"] */
function paramDecls(prettyType: string): string[] {
  const t = prettyType.trim();
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0)
      return splitParams(t.slice(i + 1, -1)).filter((p) => p !== 'void');
  }
  return [];
}

function scalarKind(node: CbmcIrep | undefined): 'scalar' | 'float' | 'other' {
  if (!node?.id) return 'other';
  if (node.id === 'floatbv') return 'float';
  return SCALAR_TYPES.has(node.id) ? 'scalar' : 'other';
}

/** Arrays (of any depth) whose elements are scalars are compared element by element. */
function arrayShape(node: CbmcIrep | undefined): { dims: number; element: 'scalar' | 'float' } | null {
  let n = node;
  let dims = 0;
  while (n?.id === 'array') {
    n = n.sub?.[0];
    dims++;
  }
  const element = scalarKind(n);
  return dims > 0 && element !== 'other' ? { dims, element } : null;
}

export function eqProgram(msgs: CbmcMessage[], fileName: string): EqProgram {
  const table = msgs.find((m) => m.symbolTable)?.symbolTable ?? {};
  const functions = new Map<string, EqFunction>();
  const globals = new Map<string, EqGlobal>();
  const bodiless = new Set<string>();
  for (const sym of Object.values(table)) {
    const name = sym.name ?? '';
    if (!/^[A-Za-z_]\w*$/.test(name) || sym.isType || irep(sym.location, 'file') !== fileName) continue;
    if (sym.type?.id === 'code') {
      if (!sym.value?.id || sym.value.id === 'nil') {
        // Implicitly declared abort/exit land here too; the harness defines those.
        if (!TERMINATORS.includes(name)) bodiless.add(name);
        continue;
      }
      const ps = sym.type.namedSub?.parameters?.sub ?? [];
      const decls = paramDecls(sym.prettyType ?? '');
      const params = ps.map((p, i): EqParam => {
        const base = irep(p, '#base_name') ?? `arg${i}`;
        const decl = decls[i] ?? '';
        const declType = decl.endsWith(base) ? decl.slice(0, decl.length - base.length).trim() : decl;
        return { name: base, declType, scalar: scalarKind(p.namedSub?.type) !== 'other' && declType !== '' };
      });
      const ret = sym.type.namedSub?.return_type;
      functions.set(name, {
        name,
        line: Number(irep(sym.location, 'line') ?? 0),
        typeKey: canonicalType(sym.type),
        params,
        returns: ret?.id === 'empty' ? 'void' : scalarKind(ret),
        body: sym.prettyValue ?? '',
        callees: [],
        undefinedCalls: [],
        variadic: /\.\.\.\s*\)\s*$/.test(sym.prettyType ?? ''),
      });
    } else if (sym.isStaticLifetime) {
      const shape = arrayShape(sym.type);
      globals.set(name, {
        name,
        typeKey: canonicalType(sym.type),
        kind: shape ? 'array' : scalarKind(sym.type),
        ...(shape ? { dims: shape.dims, element: shape.element } : {}),
        initializer: canonicalType(sym.value),
      });
    }
  }
  for (const f of functions.values()) {
    const called = [...f.body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!);
    f.callees = [...new Set(called.filter((c) => functions.has(c) && c !== f.name))];
    f.undefinedCalls = [...new Set(called.filter((c) => bodiless.has(c)))];
  }
  return { functions, globals };
}

/** Functions whose behavior may differ: changed bodies, and everything that (transitively) calls them. */
export function changedFunctions(original: EqProgram, candidate: EqProgram): string[] {
  const initializersChanged = [...original.globals.values()].some(
    (g) => candidate.globals.get(g.name)?.initializer !== g.initializer,
  );
  const changed = new Set<string>();
  for (const f of original.functions.values()) {
    const c = candidate.functions.get(f.name);
    if (!c || c.body !== f.body || initializersChanged) changed.add(f.name);
  }
  // Propagate through the candidate's call graph (new helpers count as changed).
  for (const c of candidate.functions.values()) if (!original.functions.has(c.name)) changed.add(c.name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of candidate.functions.values()) {
      if (!changed.has(c.name) && c.callees.some((x) => changed.has(x))) {
        changed.add(c.name);
        grew = true;
      }
    }
  }
  return [...original.functions.keys()].filter((n) => changed.has(n));
}

/** Globals must survive with their types; the behavior check compares them. */
export function globalsRejection(original: EqProgram, candidate: EqProgram): Rejection | null {
  for (const g of original.globals.values()) {
    const c = candidate.globals.get(g.name);
    if (!c)
      return {
        guard: 'globals',
        message: `The global variable ${g.name} was removed; keep every global variable.`,
      };
    if (c.typeKey !== g.typeKey) {
      return {
        guard: 'globals',
        message: `The type of the global variable ${g.name} changed; keep its type.`,
      };
    }
  }
  return null;
}

const renames = (names: Iterable<string>, prefix: string) =>
  [...names].map((n) => `#define ${n} ${prefix}${n}`).join('\n');

function equalityExpr(kind: 'scalar' | 'float', a: string, b: string): string {
  if (kind === 'float') return `((${a}) == (${b}) || ((${a}) != (${a}) && (${b}) != (${b})))`;
  return `(${a}) == (${b})`;
}

/**
 * Compares one global after both calls. An array is compared at a symbolic
 * index, so the assertion fails exactly when some element differs; every
 * back end decides that soundly, unlike __CPROVER_array_equal, whose SMT
 * encoding in CBMC reports differences that do not exist. The two values go
 * through locals so the counterexample shows them.
 */
function globalCheck(g: EqGlobal): string[] {
  const lines = ['  {'];
  let index = '';
  for (let k = 0; k < (g.kind === 'array' ? (g.dims ?? 1) : 0); k++) {
    const outer = `${g.name}${'[0]'.repeat(k)}`;
    lines.push(
      `    __CPROVER_size_t __vw_i${k};`,
      `    __CPROVER_assume(__vw_i${k} < sizeof(${outer}) / sizeof(${outer}[0]));`,
    );
    index += `[__vw_i${k}]`;
  }
  const kind = g.kind === 'array' ? (g.element ?? 'scalar') : g.kind === 'float' ? 'float' : 'scalar';
  lines.push(
    `    __typeof__(${g.name}${index}) __vw_go = (*${PREFIX_ORIGINAL}g_${g.name})${index};`,
    `    __typeof__(${g.name}${index}) __vw_gc = ${g.name}${index};`,
    `    __CPROVER_assert(${equalityExpr(kind, '__vw_go', '__vw_gc')}, "${ASSERT_TAG}: global ${g.name}");`,
    '  }',
  );
  return lines;
}

export interface EquivalenceOptions {
  original: string;
  candidate: string;
  fileName: string;
  checks: CheckId[];
  unwind: number;
  solver: SolverId;
}

export interface EquivalenceDeps {
  config: CoreConfig;
  runner: Runner;
  detector: EngineDetector;
}

export interface EquivalenceReport {
  results: EquivalenceResult[];
  /** A structural problem (removed or retyped global) that rejects the candidate outright. */
  rejection?: Rejection;
  /** Why no proof was attempted at all (e.g. CBMC is not installed). */
  unavailable?: string;
}

export async function checkEquivalence(
  opts: EquivalenceOptions,
  deps: EquivalenceDeps,
): Promise<EquivalenceReport> {
  const engines = await deps.detector.get();
  if (!engines.cbmc.available)
    return { results: [], unavailable: 'the behavior check needs CBMC, which is not installed' };
  const cbmcSolver = engines.cbmc.solvers.some((s) => s.id === opts.solver && s.available)
    ? opts.solver
    : (engines.cbmc.defaultSolver ?? 'minisat');
  const bins = deps.config.bins;

  return withWorkspace(async (dir) => {
    const run = (bin: string, args: string[], cwd = dir): Promise<RunResult> =>
      deps.runner.run(bin, args, {
        cwd,
        timeoutMs: deps.config.timeoutMs,
        maxOutputBytes: deps.config.maxOutputBytes,
        memoryLimitMb: deps.config.memoryLimitMb,
      });
    // goto-cc and goto-instrument ship with CBMC: next to CBMC_BIN when that is a path, else on PATH.
    const sibling = (name: string) =>
      bins.cbmc.includes('/') ? path.join(path.dirname(bins.cbmc), name) : name;

    // 1. Read both versions' symbols. CBMC leaves unused file-local globals out
    // of its symbol table, so the candidate is read with a generated function
    // that uses every global of the original: a global the candidate removed
    // then fails to compile, and one it merely stopped using is still there to
    // be compared (gutting a function that writes a buffer is a difference).
    const symbolsOf = async (version: 'o' | 'c', code: string) => {
      await fs.mkdir(path.join(dir, version), { recursive: true });
      await fs.writeFile(path.join(dir, version, opts.fileName), code);
      const r = await run(
        bins.cbmc,
        [opts.fileName, '--show-symbol-table', '--json-ui', ...deps.config.extraFlags.cbmc],
        path.join(dir, version),
      );
      return parseJsonUi(r.stdout) ?? [];
    };
    const om = await symbolsOf('o', opts.original);
    if (!om.some((m) => m.symbolTable))
      return { results: [], unavailable: 'CBMC could not read the original' };
    const original = eqProgram(om, opts.fileName);
    const globalNames = [...original.globals.keys()];
    const firstUse = opts.candidate.split('\n').length + 2;
    const uses = [`void ${USES}(void) {`, ...globalNames.map((g) => `  (void)&${g};`), '}'].join('\n');
    const cm = await symbolsOf('c', `${opts.candidate}\n${uses}\n`);
    if (!cm.some((m) => m.symbolTable)) {
      // The candidate compiles on its own (it was verified first), so the generated uses broke it.
      const err = cbmcDiagnostics(cm).find((d) => d.severity === 'error');
      const missing =
        (err?.line !== undefined ? globalNames[err.line - firstUse] : undefined) ??
        globalNames.find((g) => err?.message.includes(`'${g}'`));
      if (!missing) {
        // CBMC read the original, so whatever it cannot read now came with the patch.
        return {
          results: [],
          rejection: {
            guard: 'behavior',
            message: `The behavior check could not read the patched code: ${err?.message ?? 'CBMC failed'}.`,
          },
        };
      }
      return {
        results: [],
        rejection: {
          guard: 'globals',
          message: `The global variable ${missing} was removed; keep every global variable.`,
        },
      };
    }
    const candidate = eqProgram(cm, opts.fileName);
    candidate.functions.delete(USES);

    const rejection = globalsRejection(original, candidate);
    if (rejection) return { results: [], rejection };

    const names = [
      ...original.functions.keys(),
      ...original.globals.keys(),
      ...candidate.functions.keys(),
      ...candidate.globals.keys(),
    ];
    if (names.some((n) => n.startsWith('__vw_'))) {
      return {
        results: [],
        unavailable: 'identifiers starting with __vw_ are reserved for the behavior check',
      };
    }

    // 2. Decide what to prove.
    const results: EquivalenceResult[] = [];
    const targets: EqFunction[] = [];
    for (const name of changedFunctions(original, candidate)) {
      const o = original.functions.get(name)!;
      const c = candidate.functions.get(name);
      if (!c || c.typeKey !== o.typeKey) continue; // the signature guard reports these
      const reaches = (fn: EqFunction, seen = new Set<string>()): string[] => {
        if (seen.has(fn.name)) return [];
        seen.add(fn.name);
        return [
          ...fn.undefinedCalls,
          ...fn.callees.flatMap((n) =>
            candidate.functions.has(n) ? reaches(candidate.functions.get(n)!, seen) : [],
          ),
        ];
      };
      const bodiless = [...new Set(reaches(c))];
      const unsupported = c.params.some((p) => !p.scalar)
        ? 'it takes pointer or aggregate parameters'
        : c.returns === 'other'
          ? 'it returns a pointer or aggregate'
          : c.variadic
            ? 'it is variadic'
            : bodiless.length
              ? `it calls functions without a body (${bodiless.join(', ')})`
              : null;
      if (unsupported)
        results.push({ function: name, status: 'skipped', reason: `not behavior-checked: ${unsupported}` });
      else targets.push(c);
    }
    const ordered = (rs: EquivalenceResult[]) =>
      rs.sort((a, b) => original.functions.get(a.function)!.line - original.functions.get(b.function)!.line);
    if (targets.length === 0) return { results: ordered(results) };

    const compared = [...original.globals.values()].filter((g) => g.kind !== 'other');

    // 3. Build both versions side by side.
    const originalTu = [
      ...ORIGINAL_PRELUDE,
      renames([...original.functions.keys(), ...original.globals.keys()], PREFIX_ORIGINAL),
      opts.original,
      '',
      '/* ---- Verifier Workbench behavior check: exports (generated) ---- */',
      ...targets.map((f) => `__typeof__(${f.name}) *${PREFIX_ORIGINAL}p_${f.name} = ${f.name};`),
      ...compared.map((g) => `__typeof__(${g.name}) *${PREFIX_ORIGINAL}g_${g.name} = &${g.name};`),
      '',
    ].join('\n');

    const harness = targets.map((f) => {
      const args = f.params.map((_, i) => `__vw_a${i}`).join(', ');
      const lines = [
        `void __vw_eq_${f.name}(void) {`,
        ...f.params.map((p, i) => `  ${p.declType} __vw_a${i};`),
      ];
      const call = (callee: string) => `${callee}(${args})`;
      if (f.returns === 'void' || f.returns === 'other') {
        // 'other' never gets here (such functions are skipped); void has no value to compare.
        lines.push(
          `  ${PHASE} = 1;`,
          `  ${call(`${PREFIX_ORIGINAL}p_${f.name}`)};`,
          `  ${PHASE} = 2;`,
          `  ${call(f.name)};`,
        );
      } else {
        lines.push(
          `  ${PHASE} = 1;`,
          `  __typeof__(${call(f.name)}) __vw_ro = ${call(`${PREFIX_ORIGINAL}p_${f.name}`)};`,
          `  ${PHASE} = 2;`,
          `  __typeof__(${call(f.name)}) __vw_rc = ${call(f.name)};`,
          `  __CPROVER_assert(${equalityExpr(f.returns, '__vw_ro', '__vw_rc')}, "${ASSERT_TAG}: return value");`,
        );
      }
      for (const g of compared) lines.push(...globalCheck(g));
      lines.push('}');
      return lines.join('\n');
    });
    const candidateTu = [
      renames([...candidate.functions.keys(), ...candidate.globals.keys()], PREFIX_CANDIDATE),
      opts.candidate,
      '',
      '/* ---- Verifier Workbench behavior check: harness (generated) ---- */',
      ...targets.map((f) => `extern __typeof__(${f.name}) *${PREFIX_ORIGINAL}p_${f.name};`),
      ...compared.map((g) => `extern __typeof__(${g.name}) *${PREFIX_ORIGINAL}g_${g.name};`),
      `extern int ${PHASE};`,
      ...harness,
      '',
    ].join('\n');
    await fs.writeFile(path.join(dir, 'o', opts.fileName), originalTu);
    await fs.writeFile(path.join(dir, 'c', opts.fileName), candidateTu);
    await fs.mkdir(path.join(dir, 'shim'));
    await fs.writeFile(path.join(dir, 'shim', 'assert.h'), ASSUMING_ASSERT_H);
    await fs.writeFile(path.join(dir, 'termination.c'), TERMINATION_TU);

    const checkFlags = opts.checks.map((c) => CHECK_FLAGS[c]);
    // [tool, args, cwd, whether a failure can only come from the patched code]
    const steps: [string, string[], string, boolean][] = [
      [sibling('goto-cc'), ['-I', '../shim', opts.fileName, '-o', '../o.gb'], path.join(dir, 'o'), false],
      // One pass: the check flags and --assert-to-assume together turn the
      // original's checks into assumptions (its own asserts are handled by the shim).
      [sibling('goto-instrument'), ['o.gb', 'o-assumed.gb', ...checkFlags, '--assert-to-assume'], dir, false],
      [sibling('goto-cc'), [opts.fileName, '-o', '../c.gb'], path.join(dir, 'c'), true],
      [sibling('goto-cc'), ['termination.c', '-o', 'termination.gb'], dir, false],
      [sibling('goto-cc'), ['o-assumed.gb', 'c.gb', 'termination.gb', '-o', 'eq.gb'], dir, true],
    ];
    for (const [bin, args, cwd, fromPatch] of steps) {
      const r = await run(bin, args, cwd);
      if (!r.spawnError && r.code === 0) continue;
      const tool = path.basename(bin);
      if (r.spawnError) {
        return {
          results: ordered(results),
          unavailable: `the behavior check could not run ${tool}: ${r.spawnError}`,
        };
      }
      const why = (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || `exit ${r.code}`;
      if (fromPatch) {
        // A patch must not escape the proof by breaking it.
        return {
          results: ordered(results),
          rejection: {
            guard: 'behavior',
            message: `The behavior check could not be built with the patched code (${tool}: ${why}).`,
          },
        };
      }
      const reason = `could not build the behavior check (${tool}: ${why})`;
      return {
        results: ordered([
          ...results,
          ...targets.map((f): EquivalenceResult => ({ function: f.name, status: 'skipped', reason })),
        ]),
      };
    }

    // 4. Prove each changed function.
    const proofs = await Promise.all(
      targets.map(async (f): Promise<EquivalenceResult> => {
        const r = await run(bins.cbmc, [
          'eq.gb',
          '--function',
          `__vw_eq_${f.name}`,
          '--json-ui',
          '--unwind',
          String(opts.unwind),
          '--unwinding-assertions',
          ...cbmcSolverArgs(cbmcSolver),
        ]);
        return interpretProof(f, parseJsonUi(r.stdout), r, compared);
      }),
    );
    return { results: ordered([...results, ...proofs]) };
  });
}

interface ProofStep {
  stepType?: string;
  hidden?: boolean;
  lhs?: string;
  value?: CbmcValue;
}

export function interpretProof(
  f: EqFunction,
  msgs: CbmcMessage[] | null,
  r: Pick<RunResult, 'timedOut'>,
  globals: EqGlobal[] = [],
): EquivalenceResult {
  const results = msgs?.find((m) => Array.isArray(m.result))?.result;
  if (!msgs || !results) {
    const err = msgs ? cbmcDiagnostics(msgs).find((d) => d.severity === 'error')?.message : undefined;
    return {
      function: f.name,
      status: 'inconclusive',
      reason: r.timedOut ? 'the proof timed out' : `the proof did not run${err ? `: ${err}` : ''}`,
    };
  }
  const failed = results.find((p) => p.status === 'FAILURE' && p.description?.startsWith(ASSERT_TAG));
  if (failed) {
    const trace = (failed.trace ?? []) as ProofStep[];
    const last = new Map<string, ProofStep>();
    for (const s of trace) if (s.stepType === 'assignment' && s.lhs) last.set(s.lhs, s);
    const inputs = f.params.map((p, i): WitnessValue => {
      const s = last.get(`__vw_a${i}`);
      const w: WitnessValue = { name: p.name, value: formatValue(s?.value), role: 'input' };
      const hex = bitsToHex(s?.value?.binary);
      if (hex) w.hex = hex;
      return w;
    });
    const what = failed.description!.slice(ASSERT_TAG.length + 2);
    const value = (name: string) => formatValue(last.get(name)?.value);
    if (what === 'termination') {
      return {
        function: f.name,
        status: 'different',
        reason: 'the patched code ends the program (abort or exit)',
        inputs,
      };
    }
    if (what === 'return value') {
      return {
        function: f.name,
        status: 'different',
        reason: 'the return value differs',
        inputs,
        original: value('__vw_ro'),
        candidate: value('__vw_rc'),
      };
    }
    const name = what.replace(/^global /, '');
    const g = globals.find((x) => x.name === name);
    const at =
      g?.kind === 'array'
        ? ` at ${name}${Array.from({ length: g.dims ?? 1 }, (_, k) => `[${value(`__vw_i${k}`)}]`).join('')}`
        : '';
    return {
      function: f.name,
      status: 'different',
      reason: `the global ${name} differs${at}`,
      inputs,
      original: value('__vw_go'),
      candidate: value('__vw_gc'),
    };
  }
  const unwind = results.some(
    (p) => p.status === 'FAILURE' && /unwinding assertion/.test(p.description ?? ''),
  );
  if (unwind)
    return {
      function: f.name,
      status: 'inconclusive',
      reason: 'a loop needs more unwinding to finish the proof',
    };
  if (results.some((p) => p.description?.startsWith(ASSERT_TAG) && p.status !== 'SUCCESS')) {
    return { function: f.name, status: 'inconclusive', reason: 'the solver could not decide it' };
  }
  return { function: f.name, status: 'equivalent' };
}
