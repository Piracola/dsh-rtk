/**
 * dsh-rtk-thin — route simple shell commands through `rtk rewrite` before they run.
 *
 * Design notes (what this plugin couples to, and what it deliberately avoids):
 *
 * 1. Zero DSH internals. It imports nothing from the harness: it injects the mounted
 *    `shell` service and wraps its `resolve()`. That works for whichever executor a
 *    deployment mounts (pwsh-sandbox, pwsh-local, bash-*), and cannot break when those
 *    packages reshape their classes.
 *
 * 2. Exit code is not the success signal. Measured on rtk 0.49.0 and 0.50.0: a
 *    successful rewrite exits 3 (docs say 0) and prints the rewritten command; a command
 *    with no rtk equivalent exits 1 with empty stdout. We accept any non-empty stdout
 *    that differs from the input.
 *
 * 3. The deny-list is checked on the REWRITTEN subcommand, not on the input command.
 *    rtk `ls`/`tree`/`pwd`/`wc`/`grep` proxy the Unix binary of the same name, which does
 *    not exist on Windows, so rewriting into them turns a working command into a failure.
 *    rtk >= 0.50 rewrites `cat x` to `rtk read x`, and `read` is native and works on
 *    Windows, so `cat` stays rewritable while `rtk cat` never appears.
 *    Measured 2026-09 on Windows with rtk 0.50.0: ls, tree, pwd, wc, grep fail; find and
 *    read work.
 *
 * 4. Command lists are rewritten per segment. `git status; git log -3` becomes
 *    `rtk git status; rtk git log -3`: separators (`;`, `\n`, `\r`, `&&`, `||`) stay
 *    exactly where they were and only the command text between them is replaced.
 *    Pipelines are still left alone — rtk compacts what it proxies, so
 *    `git status | grep M` would feed a different byte stream into the next command and
 *    change the match.
 *
 * 5. Anything with expansion, blocks or redirection passes through untouched: backtick,
 *    `$`, parentheses, braces, `@`, `<`, `>` and a bare `&` all mean the source is not a
 *    plain command list we can splice safely. Redirection costs nothing to skip anyway —
 *    output that goes to a file never reaches the model.
 *
 * @module dsh-rtk-thin
 */
import { spawnSync } from 'node:child_process'

export const name = 'dsh-rtk-thin'
export const inject = ['shell']

/** rtk subcommands backed by a Unix binary that Windows does not have. */
const WINDOWS_DENY = ['ls', 'tree', 'pwd', 'wc', 'grep']

/** Characters that mark source we refuse to splice — expansion, blocks, redirection. */
const UNSPLICEABLE = /[`$(){}<>@]/

/** Upper bound on segments per command, so one long script cannot spawn rtk 30 times. */
const MAX_SEGMENTS = 8

/** Rewrite results are pure, and repeated commands are common — remember the last few. */
const CACHE_LIMIT = 500

const PATCHED = Symbol.for('dsh-rtk-thin.patched')

const availability = new Map()
const cache = new Map()

/** Probe `rtk --version` once per binary per process; absence degrades to the identity transform. */
function rtkAvailable(exe) {
  const known = availability.get(exe)
  if (known !== undefined) return known
  let ok = false
  try {
    ok = spawnSync(exe, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0
  } catch {
    ok = false
  }
  availability.set(exe, ok)
  return ok
}

/** True when a rewritten command calls an rtk subcommand this platform cannot run. */
function deniedSubcommand(rewritten, deny) {
  const match = /^rtk\s+([a-z0-9-]+)/i.exec(rewritten)
  return match !== null && deny.has(match[1].toLowerCase())
}

/**
 * Split a shell source into command spans, left-to-right, in `[start, end]` pairs.
 * Separators are not returned: they stay untouched in the original string. Quoted text
 * never splits. Returns null when the source is not safely spliceable — an unbalanced
 * quote, a pipeline, a bare `&`, or a separator escaped with a backslash.
 * @param src - the shell source about to run.
 * @returns command spans, or null to leave the whole source alone.
 */
function splitSegments(src) {
  const spans = []
  let quote = null
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote !== null) {
      if (ch === quote) {
        if (src[i + 1] === quote) i++ /* doubled quote is an escape, e.g. 'it''s' */
        else quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    const separator = ch === '|' || ch === '&' || ch === ';' || ch === '\n' || ch === '\r'
    if (!separator) continue
    // `\;` is an escaped literal separator in POSIX shells — not a place we can splice.
    if (src[i - 1] === '\\') return null
    const paired = ch === '|' || ch === '&'
    if (paired) {
      if (src[i + 1] !== ch) return null /* single `|` is a pipeline, single `&` a job */
      spans.push([start, i])
      i += 1
      start = i + 1
      continue
    }
    spans.push([start, i])
    start = i + 1
  }
  if (quote !== null) return null
  spans.push([start, src.length])
  return spans
}

/** Rewrite one already-trimmed command, or return it unchanged. `scope` keys the cache. */
function rewriteOne(command, exe, deny, scope) {
  const key = `${scope}\u0000${command}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let rewritten = command
  try {
    const result = spawnSync(exe, ['rewrite', command], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const out = (result.stdout || '').trim()
    if (out !== '' && out !== command && !deniedSubcommand(out, deny)) rewritten = out
  } catch {
    /* fall through to the identity transform */
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, rewritten)
  return rewritten
}

/** Rewrite one span, keeping the whitespace the span was written with. */
function rewriteSpan(span, exe, deny, scope) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(span)
  if (match === null || match[2] === '') return span
  return match[1] + rewriteOne(match[2], exe, deny, scope) + match[3]
}

/**
 * Rewrite a shell source to its rtk equivalent, or return it unchanged.
 * @param command - the shell source about to run.
 * @param options - `exe` (binary; defaults to `RTK_EXE`, then `rtk`) and `denySubcommands`
 *   (defaults to the Windows list on win32, empty elsewhere).
 * @returns the rewritten source, or the original on every non-rewritable path.
 */
export function rewriteWithRtk(command, options = {}) {
  if (typeof command !== 'string' || command.trim() === '') return command
  const exe = options.exe ?? process.env.RTK_EXE ?? 'rtk'
  const deny = new Set(
    (options.denySubcommands ?? (process.platform === 'win32' ? WINDOWS_DENY : [])).map((s) => String(s).toLowerCase()),
  )
  if (UNSPLICEABLE.test(command)) return command
  const spans = splitSegments(command)
  if (spans === null || spans.length > MAX_SEGMENTS) return command
  if (!rtkAvailable(exe)) return command
  const scope = `${exe}\u0000${[...deny].sort().join(',')}`
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    out += command.slice(cursor, start) + rewriteSpan(command.slice(start, end), exe, deny, scope)
    cursor = end
  }
  return out + command.slice(cursor)
}

/**
 * Wrap the mounted shell executor's `resolve()`. Every other semantic — workdir,
 * timeout, env, stdin, sandbox confinement, result shape — is inherited untouched,
 * because the returned spec is a copy of the one the stock executor produced.
 */
export function apply(ctx, config) {
  const options = { exe: config?.rtkExe, denySubcommands: config?.denySubcommands }
  const shell = ctx.shell
  if (!shell || typeof shell.resolve !== 'function') return
  if (shell[PATCHED]) return
  const original = shell.resolve
  shell.resolve = function rtkResolve(request) {
    const spec = original.call(this, request)
    if (spec && typeof spec.command === 'string') {
      const next = rewriteWithRtk(spec.command, options)
      if (next !== spec.command) return { ...spec, command: next }
    }
    return spec
  }
  // configurable, or the disposer below cannot remove the marker: `delete` throws in ESM.
  Object.defineProperty(shell, PATCHED, { value: true, enumerable: false, configurable: true })
  ctx.effect(() => () => {
    shell.resolve = original
    delete shell[PATCHED]
  })
}
