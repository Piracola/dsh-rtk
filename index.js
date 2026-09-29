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
 * 4. Complex shell is left alone. `rtk rewrite` rewrites inside pipelines
 *    (`git status | grep x` -> `git status | rtk grep x`), silently changing pipeline
 *    semantics, so commands containing shell metacharacters pass through untouched.
 *
 * @module dsh-rtk-thin
 */
import { spawnSync } from 'node:child_process'

export const name = 'dsh-rtk-thin'
export const inject = ['shell']

/** rtk subcommands backed by a Unix binary that Windows does not have. */
const WINDOWS_DENY = ['ls', 'tree', 'pwd', 'wc', 'grep']

/** Any shell metacharacter marks a complex command — leave it byte-for-byte. */
const SHELL_META = /[|&;<>()`$\n]/

const PATCHED = Symbol.for('dsh-rtk-thin.patched')

let availability

/** Probe `rtk --version` once per process; absence degrades to the identity transform. */
function rtkAvailable(exe) {
  if (availability === undefined) {
    try {
      availability = spawnSync(exe, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0
    } catch {
      availability = false
    }
  }
  return availability
}

/** True when a rewritten command calls an rtk subcommand this platform cannot run. */
function deniedSubcommand(rewritten, deny) {
  const match = /^rtk\s+([a-z0-9-]+)/i.exec(rewritten)
  return match !== null && deny.has(match[1].toLowerCase())
}

/**
 * Rewrite one command to its rtk equivalent, or return it unchanged.
 * @param command - the shell source about to run.
 * @param options - `exe` (binary; defaults to `RTK_EXE`, then `rtk`) and `denySubcommands`
 *   (defaults to the Windows list on win32, empty elsewhere).
 * @returns the rewritten command, or the original on every non-rewritable path.
 */
export function rewriteWithRtk(command, options = {}) {
  const exe = options.exe ?? process.env.RTK_EXE ?? 'rtk'
  const deny = new Set(
    (options.denySubcommands ?? (process.platform === 'win32' ? WINDOWS_DENY : [])).map((s) => String(s).toLowerCase()),
  )
  if (typeof command !== 'string') return command
  const trimmed = command.trim()
  if (trimmed === '' || SHELL_META.test(trimmed)) return command
  if (!rtkAvailable(exe)) return command
  try {
    const result = spawnSync(exe, ['rewrite', trimmed], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const rewritten = (result.stdout || '').trim()
    if (rewritten !== '' && rewritten !== trimmed && !deniedSubcommand(rewritten, deny)) return rewritten
  } catch {
    /* fall through to the identity transform */
  }
  return command
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
  Object.defineProperty(shell, PATCHED, { value: true, enumerable: false })
  ctx.effect(() => () => {
    shell.resolve = original
    delete shell[PATCHED]
  })
}
