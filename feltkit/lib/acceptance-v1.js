// acceptance.v1: the declarative acceptance schema, and the course's evaluator declaration.
//
// ONE definition, shared by the app (publish-time validation, feltkit/lib/course.ts) and the
// harness (course validation and the interpreter in harness/evaluator). Plain ESM, no imports,
// no I/O. Types: acceptance-v1.d.ts. Spec: docs/courses/acceptance-v1.md.
//
// It is deliberately small: a finite registry of check kinds, approved programs given as argv
// (never a shell), bounded timeouts, paths confined to the evaluation tree, explicit all/any
// composition with bounded nesting. Anything not described here is a validation problem; nothing
// unknown is ignored. Complex logic belongs in a private evaluator.

export const ACCEPTANCE_SCHEMA = 'acceptance.v1';
export const PRIVATE_ACCEPTANCE_SCHEMA = 'aoc.private-acceptance.v1';
export const EVALUATOR_KINDS = ['declarative', 'private', 'none'];
export const CHECK_KINDS = ['command', 'test', 'output', 'files-exist', 'file-content', 'invariant', 'all', 'any'];
export const INVARIANTS = ['unchanged', 'absent', 'no-commits'];
export const TEST_FORMATS = ['cargo', 'vitest', 'none'];
export const STREAMS = ['stdout', 'stderr', 'both'];
export const LIMITS = Object.freeze({
  checks: 64, commands: 16, setup: 4, depth: 4, children: 32, argv: 32, argBytes: 512, pathBytes: 256, paths: 32,
  regexBytes: 256, textBytes: 4096, timeoutSecs: 3600, totalTimeoutSecs: 7200, idBytes: 80, descriptionBytes: 500, summaryBytes: 4000,
});

const NODE = ['node'];
/**
 * Approved programs. argv[0] must be one of these, bare (no path); the course must list it in
 * `toolchain`, and its ecosystem (the first segment of environment.ecosystem, e.g. "rust" in
 * "rust-cargo") must be one the program belongs to. `subcommands` is an allowlist for the first
 * non-flag argument; `flags` are refused (as `--flag`, `--flag=…`, or a short flag prefix) because
 * they would turn the program into a script interpreter or fetch and run new code.
 */
export const APPROVED_PROGRAMS = Object.freeze({
  cargo: { ecosystems: ['rust'], subcommands: ['test', 'build', 'check', 'run', 'clippy', 'fmt', 'doc', 'bench', 'metadata', 'tree'], flags: ['--config', '-Z'] },
  node: { ecosystems: NODE, subcommands: null, flags: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader', '-i', '--interactive', '-'] },
  npm: { ecosystems: NODE, subcommands: ['test', 'run', 'run-script', 'ci', 'install', 'ls'], flags: ['-c', '--call'] },
  npx: { ecosystems: NODE, subcommands: ['vitest', 'tsc', 'jest', 'mocha'], flags: ['-c', '--call', '-p', '--package', '-y', '--yes'] },
  pnpm: { ecosystems: NODE, subcommands: ['install', 'test', 'run', 'list', 'ls'], flags: ['-c', '--shell-mode'] },
});

const ID = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s) => new TextEncoder().encode(s).length;
const isInt = (v) => Number.isInteger(v);

function only(obj, allowed, at, problems) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${at}: unknown field "${k}"`);
}

function text(v, at, problems, { max = LIMITS.textBytes, optional = false, nonEmpty = true } = {}) {
  if (v === undefined && optional) return;
  if (typeof v !== 'string' || (nonEmpty && !v.length)) problems.push(`${at} must be a${nonEmpty ? ' non-empty' : ''} string`);
  else if (bytes(v) > max) problems.push(`${at} exceeds ${max} bytes`);
  else if (v.includes('\u0000')) problems.push(`${at} contains NUL`);
}

/** A relative path inside the evaluation tree: no absolute path, no "..", no ".git", no backslash. */
export function pathProblem(p) {
  if (typeof p !== 'string' || !p.length) return 'must be a non-empty string';
  if (bytes(p) > LIMITS.pathBytes) return `exceeds ${LIMITS.pathBytes} bytes`;
  if (p.includes('\u0000') || p.includes('\\')) return 'contains NUL or a backslash';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative to the evaluation tree';
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return 'must not contain empty, "." or ".." segments';
    if (seg === '.git') return 'must not reach into .git';
  }
  return null;
}

function paths(v, at, problems) {
  if (!Array.isArray(v) || !v.length || v.length > LIMITS.paths) { problems.push(`${at} must be an array of 1-${LIMITS.paths} paths`); return; }
  v.forEach((p, i) => { const e = pathProblem(p); if (e) problems.push(`${at}[${i}] ${e}`); });
}

const isFlag = (a) => a.startsWith('-');
function flagHit(arg, flag) {
  if (arg === flag) return true;
  if (flag.startsWith('--')) return arg.startsWith(`${flag}=`);
  return flag.length === 2 && !arg.startsWith('--') && arg.startsWith(flag) && flag !== '-';
}

/** Problems with one argv under a toolchain (approved programs, no shell, bounded). */
export function argvProblems(argv, at, { toolchain = [], ecosystem = null } = {}) {
  const problems = [];
  if (!Array.isArray(argv) || !argv.length || argv.length > LIMITS.argv) return [`${at} must be an array of 1-${LIMITS.argv} strings (argv; no shell)`];
  for (const [i, a] of argv.entries()) {
    if (typeof a !== 'string' || !a.length) problems.push(`${at}[${i}] must be a non-empty string`);
    else if (bytes(a) > LIMITS.argBytes) problems.push(`${at}[${i}] exceeds ${LIMITS.argBytes} bytes`);
    else if (a.includes('\u0000')) problems.push(`${at}[${i}] contains NUL`);
  }
  if (problems.length) return problems;
  const prog = argv[0];
  const spec = Object.hasOwn(APPROVED_PROGRAMS, prog) ? APPROVED_PROGRAMS[prog] : null;
  if (!spec) return [`${at}[0] "${prog}" is not an approved program (${Object.keys(APPROVED_PROGRAMS).join(', ')}; bare names, no paths, no shells)`];
  if (!toolchain.includes(prog)) problems.push(`${at}[0] "${prog}" is not listed in acceptance.toolchain`);
  const eco = typeof ecosystem === 'string' ? ecosystem.split('-')[0] : null;
  if (!eco || !spec.ecosystems.includes(eco)) problems.push(`${at}[0] "${prog}" is not approved for the fixture's ecosystem "${ecosystem ?? 'unset'}" (environment.ecosystem)`);
  const rest = argv.slice(1);
  for (const a of rest) for (const f of spec.flags) if (flagHit(a, f)) problems.push(`${at}: "${prog} ${f}" is refused (it would run code that is not part of the evaluation tree)`);
  if (spec.subcommands) {
    const sub = rest.find((a) => !isFlag(a));
    if (!sub || !spec.subcommands.includes(sub)) problems.push(`${at}: "${prog}" needs one of the approved subcommands ${spec.subcommands.join(', ')} (got ${sub ? `"${sub}"` : 'none'})`);
  }
  return problems;
}

function exitSpec(v, at, problems) {
  if (!isObj(v)) { problems.push(`${at} is required: { equals } | { in } | { notEquals } (no implicit default)`); return; }
  const keys = Object.keys(v);
  if (keys.length !== 1 || !['equals', 'in', 'notEquals'].includes(keys[0])) { problems.push(`${at} must have exactly one of equals, in, notEquals`); return; }
  if (keys[0] === 'in') { if (!Array.isArray(v.in) || !v.in.length || v.in.length > 16 || !v.in.every((x) => isInt(x) && x >= 0 && x <= 255)) problems.push(`${at}.in must be 1-16 exit codes (0-255)`); }
  else if (!isInt(v[keys[0]]) || v[keys[0]] < 0 || v[keys[0]] > 255) problems.push(`${at}.${keys[0]} must be an exit code (0-255)`);
}

function bound(v, at, problems) {
  if (!isObj(v) || !Object.keys(v).length) { problems.push(`${at} must be { equals?, min?, max? } with at least one`); return; }
  only(v, ['equals', 'min', 'max'], at, problems);
  for (const k of ['equals', 'min', 'max']) if (v[k] !== undefined && !(isInt(v[k]) && v[k] >= 0)) problems.push(`${at}.${k} must be a non-negative integer`);
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) problems.push(`${at}: min > max`);
}

/** Regex bounds: length, flags, and no constructs known to backtrack catastrophically. */
export function regexProblem(re, flags) {
  if (typeof re !== 'string' || !re.length) return 'regex must be a non-empty string';
  if (bytes(re) > LIMITS.regexBytes) return `regex exceeds ${LIMITS.regexBytes} bytes`;
  if (flags !== undefined && (typeof flags !== 'string' || !/^[imsu]{0,4}$/.test(flags) || new Set(flags).size !== flags.length)) return 'flags must be a subset of "imsu"';
  if (/\\[1-9]|\\k</.test(re)) return 'backreferences are not allowed';
  if (/\(\?<?[=!]/.test(re)) return 'lookaround is not allowed';
  if (/\([^()]*[+*}][^()]*\)\s*[+*{]/.test(re)) return 'nested quantifiers are not allowed';
  try { new RegExp(re, flags ?? ''); } catch (e) { return `regex does not compile: ${e.message}`; }
  return null;
}

function match(v, at, problems) {
  if (!isObj(v)) { problems.push(`${at} must be { exact } | { contains } | { regex, flags? } | { jsonPointer, equals }`); return; }
  const forms = ['exact', 'contains', 'regex', 'jsonPointer'].filter((k) => v[k] !== undefined);
  if (forms.length !== 1) { problems.push(`${at} must use exactly one of exact, contains, regex, jsonPointer`); return; }
  const f = forms[0];
  if (f === 'exact' || f === 'contains') { only(v, [f], at, problems); text(v[f], `${at}.${f}`, problems, { nonEmpty: f === 'contains' }); }
  else if (f === 'regex') { only(v, ['regex', 'flags'], at, problems); const e = regexProblem(v.regex, v.flags); if (e) problems.push(`${at}: ${e}`); }
  else {
    only(v, ['jsonPointer', 'equals'], at, problems);
    if (typeof v.jsonPointer !== 'string' || (v.jsonPointer !== '' && !v.jsonPointer.startsWith('/')) || bytes(v.jsonPointer) > LIMITS.pathBytes) problems.push(`${at}.jsonPointer must be an RFC 6901 pointer ("" or "/…")`);
    if (!('equals' in v)) problems.push(`${at}.equals is required`);
    else { try { if (bytes(JSON.stringify(v.equals)) > LIMITS.textBytes) problems.push(`${at}.equals exceeds ${LIMITS.textBytes} bytes`); } catch { problems.push(`${at}.equals must be JSON`); } }
  }
}

const COMMON = ['id', 'kind', 'description'];
const FIELDS = {
  command: [...COMMON, 'argv', 'timeoutSecs', 'cwd', 'exit'],
  test: [...COMMON, 'argv', 'timeoutSecs', 'cwd', 'exit', 'format', 'counts'],
  output: [...COMMON, 'of', 'stream', 'match'],
  'files-exist': [...COMMON, 'paths'],
  'file-content': [...COMMON, 'path', 'match'],
  invariant: [...COMMON, 'invariant', 'paths'],
  all: [...COMMON, 'of'],
  any: [...COMMON, 'of'],
};

/** Depth-first, document order: every check node with its path and depth. */
export function walkChecks(root, visit, at = 'acceptance.require', depth = 1) {
  if (!isObj(root)) return;
  visit(root, at, depth);
  if ((root.kind === 'all' || root.kind === 'any') && Array.isArray(root.of)) root.of.forEach((c, i) => walkChecks(c, visit, `${at}.of[${i}]`, depth + 1));
}

/** Leaf checks (everything but all/any), document order. */
export function leafChecks(spec) {
  const out = [];
  walkChecks(spec?.require, (c) => { if (c.kind !== 'all' && c.kind !== 'any') out.push(c); });
  return out;
}

/** Problems with an acceptance.v1 document (empty = valid). `ecosystem` is environment.ecosystem. */
export function validateAcceptanceV1(spec, { ecosystem = null } = {}) {
  const problems = [];
  if (!isObj(spec)) return ['acceptance must be an object'];
  if (spec.schema !== ACCEPTANCE_SCHEMA) problems.push(`acceptance.schema must be "${ACCEPTANCE_SCHEMA}"`);
  only(spec, ['schema', 'summary', 'toolchain', 'setup', 'require', 'preflight'], 'acceptance', problems);
  text(spec.summary, 'acceptance.summary', problems, { optional: true, max: LIMITS.summaryBytes });
  const toolchain = Array.isArray(spec.toolchain) ? spec.toolchain : [];
  if (!Array.isArray(spec.toolchain) || spec.toolchain.length > 8 || !spec.toolchain.every((p) => typeof p === 'string' && Object.hasOwn(APPROVED_PROGRAMS, p))) problems.push(`acceptance.toolchain must list approved programs only (${Object.keys(APPROVED_PROGRAMS).join(', ')})`);
  const argvCtx = { toolchain, ecosystem };
  let totalTimeout = 0; let commands = 0;
  const timeout = (v, at) => {
    if (!isInt(v) || v < 1 || v > LIMITS.timeoutSecs) problems.push(`${at} must be an integer 1-${LIMITS.timeoutSecs} (seconds; required)`);
    else totalTimeout += v;
  };
  const ids = new Map();
  const seeId = (id, at) => {
    if (typeof id !== 'string' || !ID.test(id)) { problems.push(`${at}.id must be a lowercase id (a-z 0-9 . _ : / -, at most ${LIMITS.idBytes})`); return; }
    if (ids.has(id)) problems.push(`${at}.id "${id}" is not unique`);
    ids.set(id, at);
  };
  if (spec.setup !== undefined) {
    if (!Array.isArray(spec.setup) || spec.setup.length > LIMITS.setup) problems.push(`acceptance.setup must be an array of at most ${LIMITS.setup} commands`);
    else spec.setup.forEach((s, i) => {
      const at = `acceptance.setup[${i}]`;
      if (!isObj(s)) { problems.push(`${at} must be an object`); return; }
      only(s, ['id', 'argv', 'timeoutSecs', 'cwd'], at, problems);
      seeId(s.id, at); problems.push(...argvProblems(s.argv, `${at}.argv`, argvCtx)); timeout(s.timeoutSecs, `${at}.timeoutSecs`);
      if (s.cwd !== undefined) { const e = pathProblem(s.cwd); if (e) problems.push(`${at}.cwd ${e}`); }
      commands++;
    });
  }
  const runnable = new Set();
  let count = 0;
  if (!isObj(spec.require)) problems.push('acceptance.require is required: an explicit { kind: "all" | "any", of: [...] } (no implicit default)');
  else if (spec.require.kind !== 'all' && spec.require.kind !== 'any') problems.push('acceptance.require must be an explicit "all" or "any" composition (no implicit default)');
  walkChecks(spec.require, (c, at, depth) => {
    count++;
    if (depth > LIMITS.depth) { problems.push(`${at}: nesting deeper than ${LIMITS.depth}`); return; }
    if (!CHECK_KINDS.includes(c.kind)) { problems.push(`${at}: unknown check kind ${JSON.stringify(c.kind)} (known: ${CHECK_KINDS.join(', ')})`); return; }
    only(c, FIELDS[c.kind], at, problems);
    seeId(c.id, at);
    text(c.description, `${at}.description`, problems, { optional: true, max: LIMITS.descriptionBytes });
    switch (c.kind) {
      case 'all': case 'any':
        if (!Array.isArray(c.of) || !c.of.length || c.of.length > LIMITS.children) problems.push(`${at}.of must hold 1-${LIMITS.children} checks`);
        else c.of.forEach((x, i) => { if (!isObj(x)) problems.push(`${at}.of[${i}] must be a check object`); });
        break;
      case 'command': case 'test':
        problems.push(...argvProblems(c.argv, `${at}.argv`, argvCtx)); timeout(c.timeoutSecs, `${at}.timeoutSecs`); exitSpec(c.exit, `${at}.exit`, problems);
        if (c.cwd !== undefined) { const e = pathProblem(c.cwd); if (e) problems.push(`${at}.cwd ${e}`); }
        commands++;
        if (c.kind === 'test') {
          if (!TEST_FORMATS.includes(c.format)) problems.push(`${at}.format must be one of ${TEST_FORMATS.join(', ')}`);
          if (c.counts !== undefined) {
            if (c.format === 'none') problems.push(`${at}.counts needs a format the harness can parse (cargo, vitest)`);
            if (!isObj(c.counts) || !Object.keys(c.counts).length) problems.push(`${at}.counts must be { passed?, failed?, skipped? }`);
            else { only(c.counts, ['passed', 'failed', 'skipped'], `${at}.counts`, problems); for (const k of Object.keys(c.counts)) if (['passed', 'failed', 'skipped'].includes(k)) bound(c.counts[k], `${at}.counts.${k}`, problems); }
          }
        }
        if (typeof c.id === 'string') runnable.add(c.id);
        break;
      case 'output':
        if (typeof c.of !== 'string' || !runnable.has(c.of)) problems.push(`${at}.of must name an earlier command or test check`);
        if (!STREAMS.includes(c.stream)) problems.push(`${at}.stream must be one of ${STREAMS.join(', ')}`);
        match(c.match, `${at}.match`, problems);
        break;
      case 'files-exist': paths(c.paths, `${at}.paths`, problems); break;
      case 'file-content': { const e = pathProblem(c.path); if (e) problems.push(`${at}.path ${e}`); match(c.match, `${at}.match`, problems); break; }
      case 'invariant':
        if (!INVARIANTS.includes(c.invariant)) problems.push(`${at}.invariant must be one of ${INVARIANTS.join(', ')}`);
        else if (c.invariant === 'no-commits') { if (c.paths !== undefined) problems.push(`${at}.paths is not used by no-commits`); }
        else paths(c.paths, `${at}.paths`, problems);
        break;
    }
  });
  if (count > LIMITS.checks) problems.push(`acceptance has ${count} checks; at most ${LIMITS.checks}`);
  if (commands > LIMITS.commands) problems.push(`acceptance runs ${commands} commands; at most ${LIMITS.commands}`);
  if (totalTimeout > LIMITS.totalTimeoutSecs) problems.push(`acceptance timeouts add up to ${totalTimeout}s; at most ${LIMITS.totalTimeoutSecs}s`);
  const setupIds = new Set((Array.isArray(spec.setup) ? spec.setup : []).map((s) => s?.id));
  const known = new Set([...ids.keys()].filter((id) => !setupIds.has(id)));
  const tests = new Set(leafChecks(spec).filter((c) => c.kind === 'test' && c.format !== 'none').map((c) => c.id));
  problems.push(...preflightProblems(spec.preflight, { known, countable: tests }));
  return problems;
}

/**
 * The preflight expectations a course declares (both evaluator kinds): which checks must FAIL on
 * the unchanged fixture (at least one), which must pass there, and optional exact test counts.
 */
export function preflightProblems(p, { known, countable }) {
  const problems = [];
  const at = 'acceptance.preflight';
  if (!isObj(p)) return [`${at} is required: { baseline: { mustFail: [check ids], mustPass?, counts? }, reference?: { counts? } }`];
  only(p, ['baseline', 'reference'], at, problems);
  const ref = (id, where) => { if (typeof id !== 'string' || !known.has(id)) problems.push(`${where}: "${id}" is not a check of this acceptance`); };
  const counts = (c, where) => {
    if (c === undefined) return;
    if (!isObj(c)) { problems.push(`${where} must be { <check id>: { passed?, failed? } }`); return; }
    for (const [id, v] of Object.entries(c)) {
      if (!countable.has(id)) problems.push(`${where}: "${id}" is not a test check with parsed counts`);
      if (!isObj(v) || !Object.keys(v).length) { problems.push(`${where}.${id} must be { passed?, failed? }`); continue; }
      only(v, ['passed', 'failed'], `${where}.${id}`, problems);
      for (const k of ['passed', 'failed']) if (v[k] !== undefined && !(isInt(v[k]) && v[k] >= 0)) problems.push(`${where}.${id}.${k} must be a non-negative integer`);
    }
  };
  const b = p.baseline;
  if (!isObj(b)) problems.push(`${at}.baseline is required`);
  else {
    only(b, ['mustFail', 'mustPass', 'counts'], `${at}.baseline`, problems);
    if (!Array.isArray(b.mustFail) || !b.mustFail.length) problems.push(`${at}.baseline.mustFail must name at least one check that fails on the unchanged fixture`);
    else b.mustFail.forEach((id, i) => ref(id, `${at}.baseline.mustFail[${i}]`));
    if (b.mustPass !== undefined) { if (!Array.isArray(b.mustPass)) problems.push(`${at}.baseline.mustPass must be an array`); else b.mustPass.forEach((id, i) => ref(id, `${at}.baseline.mustPass[${i}]`)); }
    counts(b.counts, `${at}.baseline.counts`);
  }
  if (p.reference !== undefined) {
    if (!isObj(p.reference)) problems.push(`${at}.reference must be an object`);
    else { only(p.reference, ['counts'], `${at}.reference`, problems); counts(p.reference.counts, `${at}.reference.counts`); }
  }
  return problems;
}

/** The private evaluator's configuration (acceptance section of a `private` course). */
export function validatePrivateAcceptance(spec, { ecosystem = null, dir = 'evaluator' } = {}) {
  const problems = [];
  if (!isObj(spec)) return ['acceptance must be an object'];
  if (spec.schema !== PRIVATE_ACCEPTANCE_SCHEMA) problems.push(`acceptance.schema must be "${PRIVATE_ACCEPTANCE_SCHEMA}" for a private evaluator`);
  only(spec, ['schema', 'public', 'summary', 'checks', 'toolchain', 'install', 'recordOnly', 'regression', 'hidden', 'timeoutSecs', 'preflight'], 'acceptance', problems);
  text(spec.public, 'acceptance.public', problems, { optional: true, max: LIMITS.summaryBytes });
  text(spec.summary, 'acceptance.summary', problems, { optional: true, max: LIMITS.summaryBytes });
  if (spec.checks !== undefined && (!Array.isArray(spec.checks) || !spec.checks.every((c) => typeof c === 'string'))) problems.push('acceptance.checks (display) must be an array of check ids');
  const toolchain = Array.isArray(spec.toolchain) ? spec.toolchain : [];
  if (!Array.isArray(spec.toolchain) || !spec.toolchain.every((p) => typeof p === 'string' && Object.hasOwn(APPROVED_PROGRAMS, p))) problems.push(`acceptance.toolchain must list approved programs only (${Object.keys(APPROVED_PROGRAMS).join(', ')})`);
  const ctx = { toolchain, ecosystem };
  if (spec.timeoutSecs !== undefined && (!isInt(spec.timeoutSecs) || spec.timeoutSecs < 1 || spec.timeoutSecs > LIMITS.timeoutSecs)) problems.push(`acceptance.timeoutSecs must be 1-${LIMITS.timeoutSecs}`);
  if (spec.install !== undefined) problems.push(...argvProblems(spec.install, 'acceptance.install', ctx));
  for (const [i, r] of (Array.isArray(spec.recordOnly) ? spec.recordOnly : spec.recordOnly === undefined ? [] : [null]).entries()) {
    if (!isObj(r)) { problems.push(`acceptance.recordOnly[${i}] must be { id, command, note? }`); continue; }
    only(r, ['id', 'command', 'note'], `acceptance.recordOnly[${i}]`, problems);
    if (typeof r.id !== 'string' || !ID.test(r.id)) problems.push(`acceptance.recordOnly[${i}].id must be a lowercase id`);
    problems.push(...argvProblems(r.command, `acceptance.recordOnly[${i}].command`, ctx));
  }
  const known = new Set();
  if (spec.regression !== undefined) {
    if (!isObj(spec.regression)) problems.push('acceptance.regression must be { command, knownFlaky?, knownFlakyNote? }');
    else {
      only(spec.regression, ['command', 'knownFlaky', 'knownFlakyNote'], 'acceptance.regression', problems);
      problems.push(...argvProblems(spec.regression.command, 'acceptance.regression.command', ctx));
      if (spec.regression.knownFlaky !== undefined && (!Array.isArray(spec.regression.knownFlaky) || spec.regression.knownFlaky.some((p) => pathProblem(p)))) problems.push('acceptance.regression.knownFlaky must be relative paths');
      known.add('regression');
    }
  }
  if (!Array.isArray(spec.hidden) || !spec.hidden.length) problems.push('acceptance.hidden must list at least one hidden acceptance file');
  else spec.hidden.forEach((h, i) => {
    const at = `acceptance.hidden[${i}]`;
    if (!isObj(h)) { problems.push(`${at} must be { file, dest, command }`); return; }
    only(h, ['file', 'dest', 'command'], at, problems);
    if (typeof h.file !== 'string' || pathProblem(h.file) || !h.file.startsWith(`${dir}/`)) problems.push(`${at}.file must be a path under ${dir}/`);
    const e = pathProblem(h.dest); if (e) problems.push(`${at}.dest ${e}`);
    problems.push(...argvProblems(h.command, `${at}.command`, ctx));
    if (typeof h.dest === 'string') known.add(`acceptance:${h.dest}`);
  });
  problems.push(...preflightProblems(spec.preflight, { known, countable: known }));
  return problems;
}

/** Problems with course.evaluator (the explicit evaluator resolution). */
export function validateEvaluatorDeclaration(doc) {
  const problems = [];
  const ev = isObj(doc) ? doc.evaluator : undefined;
  if (!isObj(ev)) return ['evaluator is required: { kind: "declarative" | "private" | "none", … } (there is no implicit evaluator)'];
  if (!EVALUATOR_KINDS.includes(ev.kind)) return [`evaluator.kind must be one of ${EVALUATOR_KINDS.join(', ')} (got ${JSON.stringify(ev.kind)})`];
  const reference = (r, under) => {
    if (r === undefined) return;
    if (!isObj(r)) { problems.push('evaluator.reference must be { file, digest? }'); return; }
    only(r, ev.kind === 'declarative' ? ['file', 'digest'] : ['file'], 'evaluator.reference', problems);
    const e = pathProblem(r.file);
    if (e) problems.push(`evaluator.reference.file ${e}`);
    else if (under && !r.file.startsWith(`${under}/`)) problems.push(`evaluator.reference.file must live under ${under}/`);
    else if (!under && (r.file.startsWith('evaluator/') || r.file.startsWith('fixture/'))) problems.push('evaluator.reference.file of a declarative course must live outside evaluator/ and fixture/ (e.g. reference/)');
    if (ev.kind === 'declarative' && !(typeof r.digest === 'string' && HEX64.test(r.digest))) problems.push('evaluator.reference.digest must pin the reference file (sha256, 64 hex)');
  };
  if (ev.kind === 'declarative') { only(ev, ['kind', 'reference'], 'evaluator', problems); reference(ev.reference, null); }
  else if (ev.kind === 'private') {
    only(ev, ['kind', 'dir', 'version', 'digest', 'reference', 'provenance'], 'evaluator', problems);
    if (ev.dir !== 'evaluator') problems.push('evaluator.dir must be "evaluator" (the course\'s private evaluator directory)');
    text(ev.version, 'evaluator.version', problems, { max: 80 });
    if (!(typeof ev.digest === 'string' && HEX64.test(ev.digest))) problems.push('evaluator.digest must pin the private evaluator directory (sha256, 64 hex)');
    text(ev.provenance, 'evaluator.provenance', problems, { optional: true, max: 200 });
    reference(ev.reference, 'evaluator');
  } else { only(ev, ['kind', 'reason'], 'evaluator', problems); text(ev.reason, 'evaluator.reason', problems, { optional: true, max: 500 }); }
  return problems;
}

/** Every acceptance-related problem of a course document: the evaluator declaration plus the acceptance section it implies. */
export function validateCourseAcceptance(doc) {
  const problems = validateEvaluatorDeclaration(doc);
  if (problems.length) return problems;
  const ecosystem = isObj(doc.environment) ? doc.environment.ecosystem ?? null : null;
  if (doc.evaluator.kind === 'declarative') return validateAcceptanceV1(doc.acceptance, { ecosystem });
  if (doc.evaluator.kind === 'private') return validatePrivateAcceptance(doc.acceptance, { ecosystem, dir: doc.evaluator.dir });
  return [];
}

/** Check ids a course's acceptance reports (for display): leaf ids of acceptance.v1, the display list otherwise. */
export function acceptanceCheckIds(doc) {
  if (!isObj(doc) || !isObj(doc.acceptance)) return [];
  if (doc.acceptance.schema === ACCEPTANCE_SCHEMA) return leafChecks(doc.acceptance).map((c) => c.id).filter((x) => typeof x === 'string');
  return Array.isArray(doc.acceptance.checks) ? doc.acceptance.checks.filter((x) => typeof x === 'string') : [];
}

export const isDigest = (d) => typeof d === 'string' && DIGEST.test(d);
