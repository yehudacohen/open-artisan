/**
 * hook-handlers.ts — Maps Claude Code hook events to bridge JSON-RPC calls.
 *
 * Each handler receives the raw hook input (JSON from stdin), sends the
 * appropriate JSON-RPC request to the bridge via Unix socket, and returns
 * the hook output (JSON for stdout + exit code).
 *
 * Hook scripts call these handlers via artisan-hook.ts CLI.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { buildRobotArtisanAutoApproveFailureFeedback } from "#core/autonomous-user-gate"
import { IMPLEMENTATION_REVIEW_PROGRESS_IDLE_TIMEOUT_MS, MAX_REVIEW_PASSES, REVIEW_PROGRESS_HARD_TIMEOUT_MS, REVIEW_PROGRESS_IDLE_TIMEOUT_MS, REVIEW_PROGRESS_SHUTDOWN_GRACE_MS, REVIEWER_MAX_TURNS } from "#core/constants"
import { sendSocketRequest } from "./socket-transport"
import {
  getSocketPath,
  getEnabledPath,
  getActiveSessionPath,
  DEFAULT_STATE_DIR_NAME,
  REVIEWER_SUBPROCESS_ENV,
} from "./constants"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claude Code hook input (subset of fields we use). */
export interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  stop_hook_active?: boolean
  source?: string // SessionStart matcher: "startup" | "resume" | "clear" | "compact"
  prompt?: string // UserPromptSubmit: the text the user just submitted
}

/** Hook output — determines what Claude Code does with the result. */
export interface HookOutput {
  /** JSON to write to stdout (null = no output). */
  stdout: string | null
  /** Text to write to stderr (null = no output). */
  stderr: string | null
  /** Exit code: 0 = allow/continue, 2 = block/inject. */
  exitCode: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStateDir(input: HookInput): string {
  const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
  return join(projectDir, DEFAULT_STATE_DIR_NAME)
}

function isEnabled(stateDir: string): boolean {
  return existsSync(getEnabledPath(stateDir))
}

/**
 * True when this hook is running inside an isolated reviewer/approver subprocess
 * spawned by runOwnedReviewerCommand. Such subprocesses run in the project dir
 * and therefore inherit the project's open-artisan hooks; they must be fully
 * transparent to the workflow — not gated, never re-dispatching a review from
 * their own Stop hook, never clobbering the `.active-session` pointer, and never
 * receiving injected workflow context. Every handler short-circuits on this.
 */
function isReviewerSubprocess(): boolean {
  return process.env[REVIEWER_SUBPROCESS_ENV] === "1"
}

function getSessionId(stateDir: string): string {
  const sessionPath = getActiveSessionPath(stateDir)
  if (existsSync(sessionPath)) {
    const id = readFileSync(sessionPath, "utf-8").trim()
    if (id) return id
  }
  return "default"
}

function resolveSessionId(input: HookInput, stateDir: string): string {
  return input.session_id ?? getSessionId(stateDir)
}

function persistActiveSessionId(stateDir: string, sessionId: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(getActiveSessionPath(stateDir), sessionId, "utf-8")
}

/** Recognised artisan invocation heads: `./artisan …`, `artisan …`, `bun run …artisan[.ts] …`. */
const ARTISAN_HEAD = /^(?:(?:bun\s+run\s+\S*artisan(?:\.ts)?)|\.\/artisan|artisan)(?:\s|$)/

/**
 * True when `command` is a single, pure `artisan` workflow invocation that cannot
 * smuggle extra commands around it. Workflow tools are invoked as bash, so the
 * guard must distinguish a bare `artisan …` call (always allowed, even in phases
 * where general bash is blocked) from a compound shell command.
 *
 * Crucially, shell metacharacters that appear INSIDE quotes are literal — e.g. a
 * `;` or `*` in an `--artifact-description "…"` value — and must NOT disqualify
 * the command. Only unquoted control operators (`| ; & < > ( ) { }`), and
 * command/variable substitution (`$`, backtick) even inside double quotes, route
 * the call to the full guard. Single-quoted spans are fully literal.
 */
export function isPureArtisanCommand(command: string): boolean {
  const trimmed = command.trim()
  if (/[\r\n]/.test(trimmed)) return false
  if (!ARTISAN_HEAD.test(trimmed)) return false

  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (quote === "'") {
      // Single quotes: everything literal until the closing quote.
      if (c === "'") quote = null
      continue
    }
    if (quote === '"') {
      // Double quotes: literal except backslash escapes and $/backtick expansion.
      if (c === "\\") { i++; continue }
      if (c === '"') { quote = null; continue }
      if (c === "$" || c === "`") return false
      continue
    }
    // Unquoted context.
    if (c === "\\") { i++; continue } // escaped next char — literal
    if (c === "'") { quote = "'"; continue }
    if (c === '"') { quote = '"'; continue }
    if (c === "|" || c === ";" || c === "&" || c === "<" || c === ">" ||
        c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      return false
    }
  }
  // Unterminated quote is ambiguous — route to the guard.
  return quote === null
}

/** Send a JSON-RPC request to the bridge. Returns null if unavailable. */
async function bridgeCall(
  stateDir: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const socketPath = getSocketPath(stateDir)
  const response = await sendSocketRequest(socketPath, {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  })
  if (!response) return null
  const r = response as { result?: unknown; error?: { message?: string } }
  if (r.error) return null // Treat bridge errors as unavailable for hooks
  return r.result
}

/** Permissive default — allow everything when disabled or server unavailable. */
const ALLOW: HookOutput = { stdout: null, stderr: null, exitCode: 0 }

export function isWriteLikeTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  const normalized = toolName.toLowerCase()
  if (["write", "edit", "multiedit", "notebookedit"].includes(normalized)) return true
  if (normalized !== "bash") return false
  const command = String(toolInput.command ?? toolInput.cmd ?? "")
  return /(?:>>|>[^&]|\btee\b|\bsed\s+-i\b|\bdd\b.*\bof=|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?|(?:^|[;&|]\s*)(?:touch|mkdir|cp|mv|rm|rmdir|install|chmod|chown|ln|truncate|rsync|patch|cpio|unzip|tar\s+(?:-[A-Za-z]*x[A-Za-z]*|x[A-Za-z]*|--extract)|git\s+(?:add|commit|checkout|restore|reset|clean|mv|rm|apply|am)|(?:curl|wget)\b(?=.*\s(?:-o|-O|--output(?:=|\s)|--output-document(?:=|\s)))|(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|x)|(?:prettier|eslint|ruff|black|isort)\b.*(?:^|\s)(?:--write|--fix|--apply))\b|\b(?:python|python3|node|ruby|perl)\b.*\b(?:writeFile|open\s*\(|File\.write|fs\.write|write\s*\(|write_text\s*\(|write_bytes\s*\(|append_text\s*\(|append_bytes\s*\())/.test(command)
}

function bridgeUnavailableDecision(toolName: string, toolInput: Record<string, unknown>): HookOutput {
  if (!isWriteLikeTool(toolName, toolInput)) return ALLOW
  return {
    stdout: null,
    stderr: "Open Artisan is enabled but the bridge guard is unavailable. Blocking write-like tool call to preserve workflow safety.",
    exitCode: 2,
  }
}

function extractReviewToken(reviewPrompt: string): string | null {
  return reviewPrompt.match(/OPEN_ARTISAN_REVIEW_TOKEN:\s*([a-f0-9]+)/i)?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Resumable review: progress store + self-pacing protocol
//
// A large review diff cannot always be covered within REVIEWER_MAX_TURNS in a
// single pass — the reviewer runs out of turns reading files and exits
// error_max_turns, which previously failed the whole dispatch and reverted the
// task unreviewed. Instead we let the reviewer SELF-PACE: each `run-review`
// pass reviews the not-yet-covered files within its turn budget. If it cannot
// finish, it emits a `status:"partial"` object listing the files it covered,
// findings so far, and what remains; we persist that and tell the agent to run
// `./artisan run-review` again to continue. Only when the WHOLE review is
// complete does the reviewer emit the normal final verdict, which is submitted
// via the existing bridge path and the progress file cleared.
//
// This is entirely CLI-side: no bridge/daemon/core schema changes. The progress
// file lives under the project's `.openartisan/<feature>/` (writes there are
// allowed at runtime).
// ---------------------------------------------------------------------------

/** Persisted between bounded review passes. */
export interface ReviewProgress {
  /** Hash of the review prompt (token-stripped) — identifies the artifact under review. */
  artifactHash: string
  /** Number of passes completed so far (incremented each persisted partial pass). */
  pass: number
  /** Files the reviewer has already covered (must not be re-read). */
  coveredFiles: string[]
  /** Findings accumulated across passes. */
  findings: string[]
  /** Files/areas still to review. */
  remaining: string[]
}

/** The reviewer's self-paced partial-progress payload (NOT a verdict). */
export interface PartialReviewResult {
  status: "partial"
  coveredFiles?: string[]
  findings?: string[]
  remaining?: string[]
}

/**
 * Stable identifier for the artifact under review. The bridge rotates the
 * one-time review token on every dispatch, so we strip the token line before
 * hashing — the hash then stays constant across passes for the same artifact
 * and only changes when the underlying review content changes (→ start fresh).
 */
export function hashReviewPrompt(reviewPrompt: string): string {
  const stripped = reviewPrompt.replace(/OPEN_ARTISAN_REVIEW_TOKEN:\s*[a-f0-9]+/gi, "")
  return createHash("sha256").update(stripped).digest("hex").slice(0, 16)
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== "string") continue
    const t = v.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Resolve the per-feature+kind progress file path. */
export function reviewProgressPath(stateDir: string, featureName: string, kind: "task" | "phase"): string {
  const safeFeature = (featureName || "default").replace(/[^A-Za-z0-9._-]/g, "_")
  return join(stateDir, safeFeature, `review-progress.${kind}.json`)
}

/** Load progress for the given artifact hash, or null if absent / for a different artifact. */
export function loadReviewProgress(path: string, artifactHash: string): ReviewProgress | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReviewProgress>
    // A different artifact hash means the content changed — start fresh.
    if (parsed.artifactHash !== artifactHash) return null
    return {
      artifactHash,
      pass: typeof parsed.pass === "number" ? parsed.pass : 0,
      coveredFiles: uniqueStrings(parsed.coveredFiles ?? []),
      findings: uniqueStrings(parsed.findings ?? []),
      remaining: uniqueStrings(parsed.remaining ?? []),
    }
  } catch {
    return null
  }
}

/** Persist progress (creates parent dirs). */
export function saveReviewProgress(path: string, progress: ReviewProgress): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(progress, null, 2), "utf-8")
}

/** Remove any progress file (no-op if absent). */
export function clearReviewProgress(path: string): void {
  if (existsSync(path)) {
    try { unlinkSync(path) } catch { /* best-effort */ }
  }
}

/**
 * Parse the reviewer's emitted text into one of:
 *  - { kind: "partial", result } — a self-paced `{"status":"partial",...}` payload
 *  - { kind: "final" }            — anything else parseable/non-partial (the verdict)
 *
 * The verdict's own shape is opaque here (the bridge validates it on submit); we
 * only need to distinguish a partial-progress payload from a final verdict.
 */
export function classifyReviewerOutput(text: string): { kind: "partial"; result: PartialReviewResult } | { kind: "final" } {
  const obj = tryParseJsonObject(text)
  if (obj && obj["status"] === "partial") {
    return {
      kind: "partial",
      result: {
        status: "partial",
        coveredFiles: Array.isArray(obj["coveredFiles"]) ? (obj["coveredFiles"] as string[]) : [],
        findings: Array.isArray(obj["findings"]) ? (obj["findings"] as string[]) : [],
        remaining: Array.isArray(obj["remaining"]) ? (obj["remaining"] as string[]) : [],
      },
    }
  }
  return { kind: "final" }
}

/** Best-effort: parse `text` as a JSON object, tolerating prose/code-fences around it. */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)
  // Strip a ```json … ``` fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.push(fence[1].trim())
  // Last resort: first {...} span.
  const span = trimmed.match(/\{[\s\S]*\}/)
  if (span?.[0]) candidates.push(span[0])
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    } catch { /* try next candidate */ }
  }
  return null
}

/** Merge a partial result into prior progress, bumping the pass counter. */
export function mergeReviewProgress(prior: ReviewProgress | null, artifactHash: string, partial: PartialReviewResult): ReviewProgress {
  const pass = (prior?.pass ?? 0) + 1
  const coveredFiles = uniqueStrings([...(prior?.coveredFiles ?? []), ...(partial.coveredFiles ?? [])])
  const findings = uniqueStrings([...(prior?.findings ?? []), ...(partial.findings ?? [])])
  // `remaining` is authoritative from the latest pass (it shrinks); drop anything
  // now covered. Fall back to the prior remaining if the reviewer omitted it.
  const reportedRemaining = uniqueStrings(partial.remaining ?? [])
  const remaining = (reportedRemaining.length > 0 ? reportedRemaining : (prior?.remaining ?? []))
    .filter((f) => !coveredFiles.includes(f))
  return { artifactHash, pass, coveredFiles, findings, remaining: uniqueStrings(remaining) }
}

/**
 * Build the self-pacing instruction block appended to the review prompt. Includes
 * any prior progress so the reviewer resumes and does NOT re-read covered files.
 */
export function buildResumableReviewerInstructions(prior: ReviewProgress | null): string {
  const lines: string[] = []
  lines.push("")
  lines.push("---")
  lines.push("")
  lines.push("## RESUMABLE REVIEW — BOUNDED TURN BUDGET (read carefully)")
  lines.push("")
  lines.push(`You have a BOUNDED budget of ${REVIEWER_MAX_TURNS} agent turns for THIS pass. A large diff may not fit in one pass, so you must SELF-PACE across multiple passes:`)
  lines.push("")
  lines.push("1. Review the not-yet-covered files/areas this pass. Read files efficiently — do NOT re-read anything already listed under \"Already covered\" below.")
  lines.push("2. If you can complete the ENTIRE review within this pass, output ONLY your normal final verdict JSON exactly as instructed above (this is treated as `status:\"final\"`).")
  lines.push("3. If you CANNOT finish this pass, do NOT output a verdict. Instead output ONLY a JSON object of this exact shape (no prose, no code fence):")
  lines.push('   {"status":"partial","coveredFiles":["path/a.ts","path/b.ts"],"findings":["issue or note ..."],"remaining":["path/c.ts","area still to review ..."]}')
  lines.push("   - `coveredFiles`: files/areas you FULLY reviewed THIS pass (these will be merged with prior coverage and skipped next pass).")
  lines.push("   - `findings`: concrete issues/observations so far (these accumulate across passes and inform the final verdict).")
  lines.push("   - `remaining`: files/areas you have NOT yet reviewed and should be tackled next pass.")
  lines.push("4. Aim to make forward progress every pass: always FULLY cover at least one not-yet-covered file before you run low on turns, so coverage strictly grows.")
  if (prior && (prior.coveredFiles.length || prior.findings.length || prior.remaining.length)) {
    lines.push("")
    lines.push(`### Prior progress (resume from here — pass ${prior.pass} already done)`)
    if (prior.coveredFiles.length) {
      lines.push("Already covered (DO NOT re-read these):")
      for (const f of prior.coveredFiles) lines.push(`  - ${f}`)
    }
    if (prior.remaining.length) {
      lines.push("Remaining to review this pass (prioritise these):")
      for (const f of prior.remaining) lines.push(`  - ${f}`)
    }
    if (prior.findings.length) {
      lines.push("Findings so far (carry forward into the final verdict):")
      for (const f of prior.findings) lines.push(`  - ${f}`)
    }
  } else {
    lines.push("")
    lines.push("### No prior progress — this is pass 1. Start the review from the top.")
  }
  lines.push("")
  return lines.join("\n")
}

/** Outcome of interpreting a finished reviewer subprocess against the progress store. */
export type ReviewPassOutcome =
  | { kind: "final"; verdictText: string }
  | { kind: "partial"; progress: ReviewProgress; message: string }
  | { kind: "exhausted"; progress: ReviewProgress; verdictText: string | null; message: string }

/**
 * Pure decision function for a finished reviewer pass. Given the reviewer's raw
 * result (text + whether the subprocess reported ok) and prior progress, decide:
 *
 *  - `final`     → the reviewer produced its verdict; caller submits it & clears progress.
 *  - `partial`   → not done; caller persists `progress` and tells the agent to run again.
 *  - `exhausted` → termination guard tripped (pass cap or no new coverage); caller stops
 *                  looping, surfaces `message`, and optionally submits a best-effort
 *                  verdict built from accumulated findings (`verdictText`, if any).
 *
 * Factored out (and exported) so the partial→persist→resume→final loop is unit-testable
 * without spawning `claude`.
 */
export function interpretReviewPass(args: {
  reviewerOk: boolean
  reviewerText: string
  prior: ReviewProgress | null
  artifactHash: string
  maxPasses?: number
}): ReviewPassOutcome {
  const { reviewerOk, reviewerText, prior, artifactHash } = args
  const maxPasses = args.maxPasses ?? MAX_REVIEW_PASSES

  // A clean reviewer run that did NOT emit a partial payload is the final verdict.
  if (reviewerOk) {
    const classified = classifyReviewerOutput(reviewerText)
    if (classified.kind === "final") {
      return { kind: "final", verdictText: reviewerText }
    }
    const progress = mergeReviewProgress(prior, artifactHash, classified.result)
    return finishPartial(progress, prior, maxPasses)
  }

  // The subprocess did NOT end successfully (e.g. error_max_turns). Try to salvage
  // a partial payload from whatever it emitted; otherwise record a no-new-coverage
  // pass so the termination guard can detect a stuck reviewer.
  const classified = classifyReviewerOutput(reviewerText)
  const partial: PartialReviewResult = classified.kind === "partial"
    ? classified.result
    : { status: "partial", coveredFiles: [], findings: [], remaining: prior?.remaining ?? [] }
  const progress = mergeReviewProgress(prior, artifactHash, partial)
  return finishPartial(progress, prior, maxPasses)
}

function finishPartial(progress: ReviewProgress, prior: ReviewProgress | null, maxPasses: number): ReviewPassOutcome {
  const priorCovered = prior?.coveredFiles.length ?? 0
  const madeProgress = progress.coveredFiles.length > priorCovered
  const remainingCount = progress.remaining.length
  const coveredCount = progress.coveredFiles.length

  // Termination guard: stop looping on the pass cap, or on a pass that added no
  // new coverage (a stuck reviewer) — but give a no-progress pass a one-pass grace
  // on the very first pass (prior===null) so a reviewer that legitimately produced
  // no coverage yet still gets a second chance.
  const hitCap = progress.pass >= maxPasses
  const noNewCoverage = prior !== null && !madeProgress
  if (hitCap || noNewCoverage) {
    const reason = hitCap
      ? `review pass cap (${maxPasses}) reached`
      : "a review pass added no new file coverage"
    const verdictText = buildBestEffortVerdict(progress)
    return {
      kind: "exhausted",
      progress,
      verdictText,
      message: `Resumable review stopped after ${progress.pass} pass(es): ${reason}. ${coveredCount} file(s) covered, ${remainingCount} remaining. ${verdictText ? "Submitting a best-effort verdict from accumulated findings." : "No verdict could be derived; the review was not submitted — inspect findings manually."}`,
    }
  }

  return {
    kind: "partial",
    progress,
    message: `Review pass ${progress.pass} complete — ${coveredCount} file(s) covered, ${remainingCount} remaining. Run \`./artisan run-review\` again to continue.`,
  }
}

/**
 * Build a best-effort phase/task verdict JSON from accumulated findings when the
 * termination guard stops the loop. Returns null when there are no findings to
 * justify a verdict (caller then refrains from submitting). A non-empty findings
 * list is treated as changes-requested.
 */
export function buildBestEffortVerdict(progress: ReviewProgress): string | null {
  if (progress.findings.length === 0) return null
  return JSON.stringify({
    passed: false,
    satisfied: false,
    issues: progress.findings,
    reasoning: `Resumable review terminated after ${progress.pass} pass(es) without converging; ${progress.coveredFiles.length} file(s) covered, ${progress.remaining.length} remaining. Best-effort verdict assembled from accumulated findings.`,
    scores: { code_quality: 0, error_handling: 0 },
  })
}

/**
 * Build the `claude` argv for the isolated reviewer.
 *
 * - `--max-turns > 1`: the prompt tells the reviewer to Read/Glob artifact (and
 *   source) files before answering; the first tool call consumes a turn, so a
 *   single-turn budget exits with "Reached max turns (1)" before it can answer.
 * - `--output-format stream-json --verbose`: a plain `--print` reviewer emits NO
 *   output until it finishes, so the progress idle-timeout watchdog (which resets
 *   only on output) kills any review whose silent work exceeds the idle window.
 *   Streaming emits events throughout the run, keeping the watchdog satisfied;
 *   the final verdict is carried in the terminal `result` event.
 * - `--allowedTools`: in headless `--print` mode Claude Code auto-allows read-only
 *   tools (Read/Glob/Grep) but DENIES Bash, because Bash can mutate. A reviewer
 *   that must *run the tests* to verify a task therefore had every runner call
 *   (`vitest`, `npm test`, `tsc`, `bun`) silently denied — it could read code but
 *   never execute it, and (correctly) flagged "test execution blocked". Rather than
 *   allow blanket `Bash` (which would let the reviewer run arbitrary, possibly
 *   mutating, shell), the allowlist scopes Bash to a curated set of read-only
 *   VERIFICATION targets — the project's `test`/`typecheck` scripts across the
 *   common runners — via prefix-matched `Bash(<cmd>:*)` specifiers. The reviewer
 *   can run the suite to verify a task but cannot use Bash for anything else. It
 *   stays transparent to the workflow it reviews via the subprocess marker (its
 *   artisan-guard hook no-ops). Read/Glob/Grep are listed explicitly because once
 *   `--allowedTools` is given it becomes the exhaustive allowlist (the implicit
 *   read-only auto-allow no longer applies).
 */
/**
 * Read-only verification commands the reviewer may run, scoped by prefix. These are
 * the standard `test` / `typecheck` targets across the runners a project might use;
 * each becomes a `Bash(<cmd>:*)` permission specifier so the reviewer can execute
 * the suite but not arbitrary shell. Extend here if a new runner target is needed.
 */
export const REVIEWER_VERIFY_COMMANDS: ReadonlyArray<string> = [
  "bun run test",
  "bun run typecheck",
  "bun test",
  "bunx vitest",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "yarn test",
  "npx vitest",
  "npx tsc",
  "tsc",
  "vitest",
]

/**
 * The reviewer's `--allowedTools` value: read/search tools plus the scoped verify
 * commands. Comma-separated because the `Bash(...)` specifiers contain spaces, so a
 * space-separated list would be mis-tokenised.
 */
export const REVIEWER_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  ...REVIEWER_VERIFY_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
].join(",")

export function reviewerCommandArgs(reviewPrompt: string): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(REVIEWER_MAX_TURNS),
    "--allowedTools",
    REVIEWER_ALLOWED_TOOLS,
    "-p",
    reviewPrompt,
  ]
}

/**
 * Extract the reviewer's final answer from a `stream-json` transcript. The CLI
 * emits one JSON event per line; the terminal `{ type: "result" }` event carries
 * the assistant's final text in its `result` field. Returns ok=false (with a
 * detail) when no successful result event was emitted (e.g. max-turns, error).
 */
export function extractStreamJsonResult(stdout: string): { ok: boolean; text: string; detail?: string } {
  let resultEvent: Record<string, unknown> | null = null
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event && event.type === "result") resultEvent = event
    } catch { /* non-JSON line (shouldn't occur in stream-json) — ignore */ }
  }
  if (!resultEvent) return { ok: false, text: "", detail: "reviewer stream produced no result event" }
  const text = typeof resultEvent.result === "string" ? resultEvent.result : ""
  if (resultEvent.is_error === true || resultEvent.subtype !== "success") {
    return { ok: false, text, detail: `reviewer ended with subtype=${String(resultEvent.subtype)}` }
  }
  return { ok: true, text }
}

async function runOwnedReviewerCommand(reviewPrompt: string, cwd: string, label: string, phase?: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", reviewerCommandArgs(reviewPrompt), {
      cwd,
      // Mark the child so the project's inherited open-artisan hooks no-op:
      // the reviewer must be transparent to the workflow it is reviewing.
      env: { ...process.env, [REVIEWER_SUBPROCESS_ENV]: "1" },
      // stdin must be closed (not an open, never-written pipe): claude in print
      // mode otherwise waits ~3s for stdin EOF, warns on stderr, and the stall
      // can leave the headless run exiting non-zero with no output.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const idleTimeoutMs = phase === "IMPLEMENTATION" ? IMPLEMENTATION_REVIEW_PROGRESS_IDLE_TIMEOUT_MS : REVIEW_PROGRESS_IDLE_TIMEOUT_MS

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (killTimer) clearTimeout(killTimer)
      idleTimer = null
      hardTimer = null
      killTimer = null
    }
    const terminateOwnedChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, REVIEW_PROGRESS_SHUTDOWN_GRACE_MS)
    }
    const rejectOnce = (message: string) => {
      if (settled) return
      settled = true
      clearTimers()
      terminateOwnedChild()
      reject(new Error(`${message}${stderr.trim() ? ` | stderr: ${stderr.trim()}` : ""}${stdout.trim() ? ` | stdout: ${stdout.trim()}` : ""}`))
    }
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => rejectOnce(`${label} idle timeout after ${idleTimeoutMs}ms`), idleTimeoutMs)
    }

    hardTimer = setTimeout(() => rejectOnce(`${label} hard timeout after ${REVIEW_PROGRESS_HARD_TIMEOUT_MS}ms`), REVIEW_PROGRESS_HARD_TIMEOUT_MS)
    armIdleTimer()
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
      armIdleTimer()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8")
      armIdleTimer()
    })
    child.on("error", (error) => rejectOnce(`${label} failed to start: ${error.message}`))
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimers()
      // Reviewer runs in stream-json: pull the verdict out of the terminal
      // result event so callers receive the same clean JSON they did under
      // plain --print. A missing/error result event is a failed review.
      const parsed = extractStreamJsonResult(stdout)
      if (!parsed.ok) {
        const detail = parsed.detail ? ` | ${parsed.detail}` : ""
        resolve({ stdout: parsed.text, stderr: `${stderr}${detail}`.trim(), exitCode: code && code !== 0 ? code : 1 })
        return
      }
      resolve({ stdout: parsed.text, stderr, exitCode: 0 })
    })
  })
}

// ---------------------------------------------------------------------------
// Explicit review dispatch (invoked by `./artisan run-review`)
//
// These run the isolated reviewer and submit its verdict via the one-time token.
// They are called EXPLICITLY by the agent (a visible, awaited Bash command) rather
// than fired invisibly by the Stop hook on turn-end — which was fragile (no dispatch
// + no notification when the turn didn't end the way the hook expected). The Stop
// hook now only nudges the agent to run this. Isolation is unchanged: still a fresh
// marker-isolated `claude`, token-submitted.
// ---------------------------------------------------------------------------

export interface ReviewDispatchResult {
  ok: boolean
  message: string
  /** True when this pass made partial progress; the agent should run `run-review` again. */
  partial?: boolean
}

/** Resolve the feature name for progress-file keying (best-effort; falls back to "default"). */
async function getFeatureName(stateDir: string, sessionId: string): Promise<string> {
  const state = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
  const name = state?.featureName
  return typeof name === "string" && name ? name : "default"
}

/** Dispatch the pending PHASE review for a session at <phase>/REVIEW. */
export async function dispatchOwnedPhaseReview(
  stateDir: string,
  sessionId: string,
  projectDir: string,
  phase?: unknown,
): Promise<ReviewDispatchResult> {
  const reviewPrompt = await bridgeCall(stateDir, "task.getPhaseReviewContext", { sessionId })
  if (!reviewPrompt || typeof reviewPrompt !== "string") {
    return { ok: false, message: "No phase-review context available — is the session at a <phase>/REVIEW with a submitted artifact?" }
  }
  const reviewToken = extractReviewToken(reviewPrompt)
  const featureName = await getFeatureName(stateDir, sessionId)
  const progressPath = reviewProgressPath(stateDir, featureName, "phase")
  const artifactHash = hashReviewPrompt(reviewPrompt)
  const prior = loadReviewProgress(progressPath, artifactHash)
  const augmentedPrompt = reviewPrompt + buildResumableReviewerInstructions(prior)

  // Submit a final/best-effort verdict through the existing bridge path and clear
  // progress. Returns the post-submit dispatch outcome.
  const submitVerdict = async (verdictText: string): Promise<ReviewDispatchResult> => {
    const submitResult = await bridgeCall(stateDir, "tool.execute", {
      name: "submit_phase_review",
      args: { review_output: verdictText, review_token: reviewToken },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    if (typeof submitResult === "string" && submitResult.startsWith("Error:")) throw new Error(submitResult)
    const nextState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
    if (nextState?.phaseState === "REVIEW") throw new Error("Phase review submission did not advance the workflow out of REVIEW")
    clearReviewProgress(progressPath)
    return { ok: true, message: `Phase review completed. Now at ${nextState?.phase ?? "?"}/${nextState?.phaseState ?? "?"}.` }
  }

  try {
    const result = await runOwnedReviewerCommand(augmentedPrompt, projectDir, "phase-review", phase)
    const outcome = interpretReviewPass({ reviewerOk: result.exitCode === 0, reviewerText: result.stdout, prior, artifactHash })
    if (outcome.kind === "final") return await submitVerdict(outcome.verdictText)
    if (outcome.kind === "partial") {
      saveReviewProgress(progressPath, outcome.progress)
      return { ok: true, partial: true, message: outcome.message }
    }
    // exhausted — stop looping. Submit a best-effort verdict if we have one.
    if (outcome.verdictText) {
      const submitted = await submitVerdict(outcome.verdictText)
      return { ok: true, message: `${outcome.message} ${submitted.message}` }
    }
    clearReviewProgress(progressPath)
    return { ok: false, message: outcome.message }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_phase_review",
      args: { review_token: reviewToken, review_error: errMsg, review_exit_code: 1 },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    clearReviewProgress(progressPath)
    return { ok: false, message: `Phase review failed and was recorded: ${errMsg}` }
  }
}

/** Dispatch the pending per-task review for a session with taskCompletionInProgress set. */
export async function dispatchOwnedTaskReview(
  stateDir: string,
  sessionId: string,
  projectDir: string,
): Promise<ReviewDispatchResult> {
  const reviewPrompt = await bridgeCall(stateDir, "task.getReviewContext", { sessionId })
  if (!reviewPrompt || typeof reviewPrompt !== "string") {
    return { ok: false, message: "No task-review context available — is a task awaiting review (taskCompletionInProgress)?" }
  }
  const reviewToken = extractReviewToken(reviewPrompt)
  const featureName = await getFeatureName(stateDir, sessionId)
  const progressPath = reviewProgressPath(stateDir, featureName, "task")
  const artifactHash = hashReviewPrompt(reviewPrompt)
  const prior = loadReviewProgress(progressPath, artifactHash)
  const augmentedPrompt = reviewPrompt + buildResumableReviewerInstructions(prior)

  const submitVerdict = async (verdictText: string): Promise<ReviewDispatchResult> => {
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_task_review",
      args: { review_output: verdictText, review_token: reviewToken },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    clearReviewProgress(progressPath)
    const newState = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
    if (newState?.taskCompletionInProgress) {
      return { ok: false, message: "Per-task review is still pending (parse failed or revisions requested). Address feedback or re-run ./artisan run-review." }
    }
    return { ok: true, message: "Per-task review completed. Continue with the next implementation task." }
  }

  try {
    const result = await runOwnedReviewerCommand(augmentedPrompt, projectDir, "task-review")
    const outcome = interpretReviewPass({ reviewerOk: result.exitCode === 0, reviewerText: result.stdout, prior, artifactHash })
    if (outcome.kind === "final") return await submitVerdict(outcome.verdictText)
    if (outcome.kind === "partial") {
      saveReviewProgress(progressPath, outcome.progress)
      return { ok: true, partial: true, message: outcome.message }
    }
    // exhausted — stop looping; submit a best-effort verdict if available.
    if (outcome.verdictText) {
      const submitted = await submitVerdict(outcome.verdictText)
      return { ok: submitted.ok, message: `${outcome.message} ${submitted.message}` }
    }
    clearReviewProgress(progressPath)
    return { ok: false, message: outcome.message }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await bridgeCall(stateDir, "tool.execute", {
      name: "submit_task_review",
      args: {
        review_token: reviewToken,
        review_output: JSON.stringify({ passed: false, issues: [`Review dispatch failed: ${errMsg}`], scores: { code_quality: 0, error_handling: 0 }, reasoning: "Reviewer subprocess failed; task reverted to pending." }),
      },
      context: { sessionId, directory: projectDir, invocation: "isolated-reviewer" },
    })
    clearReviewProgress(progressPath)
    return { ok: false, message: `Per-task review dispatch failed — task reverted to pending: ${errMsg}` }
  }
}

// ---------------------------------------------------------------------------
// PreToolUse handler
// ---------------------------------------------------------------------------

/**
 * PreToolUse: Enforces the tool guard on every tool call.
 *
 * - If disabled: allow all (exit 0)
 * - If server unavailable: fail closed for write-like tools, allow read-only tools
 * - If Bash tool with `artisan` command: always allow (workflow commands bypass guard)
 * - Otherwise: call guard.check, block if not allowed
 */
export async function handlePreToolUse(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: never gate its tool calls.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const toolName = input.tool_name ?? ""
  const toolInput = input.tool_input ?? {}

  // Pure artisan CLI invocations are workflow commands — always allow.
  // Compound shell commands must go through guard.check so they cannot hide
  // writes before or around an artisan invocation.
  if (toolName.toLowerCase() === "bash") {
    const command = (toolInput.command ?? toolInput.cmd ?? "") as string
    if (isPureArtisanCommand(command)) {
      return ALLOW
    }
  }

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)

  // Ensure the session is registered (idempotent — handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  const result = await bridgeCall(stateDir, "guard.check", {
    toolName,
    args: toolInput,
    sessionId,
  })

  if (!result) return bridgeUnavailableDecision(toolName, toolInput) // Server unavailable — fail closed for writes

  const guard = result as { allowed: boolean; reason?: string; phase?: string; phaseState?: string }
  if (guard.allowed) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: `[Workflow: ${guard.phase ?? "?"}/${guard.phaseState ?? "?"}]`,
        },
      }),
      stderr: null,
      exitCode: 0,
    }
  }

  // Blocked — exit 2 with reason on stderr
  return {
    stdout: null,
    stderr: guard.reason ?? `Tool "${toolName}" is blocked by the workflow guard.`,
    exitCode: 2,
  }
}

// ---------------------------------------------------------------------------
// Stop handler
// ---------------------------------------------------------------------------

/**
 * Stop: Re-prompts idle agents.
 *
 * - If disabled or server unavailable: allow stop (exit 0)
 * - reprompt/escalate: exit 2 with message on stderr (prevents stop)
 * - ignore: exit 0 (Claude stops normally)
 */
export async function handleStop(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: must stop cleanly. If its own Stop hook
  // reprompted (exit 2), the headless `claude --print` reviewer cannot continue
  // and exits non-zero, which the parent records as a failed review dispatch.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)

  // Ensure session exists (handles mid-session enable).
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  // When the agent stops at USER_GATE, the next interaction will be from the
  // user. Set userGateMessageReceived so submit_feedback becomes allowed.
  // (No-op if not at USER_GATE — processUserMessage only intercepts at gates.)
  await bridgeCall(stateDir, "message.process", {
    sessionId,
    source: "synthetic",
    parts: [{ type: "text", text: "(agent stopped — next message is from user)" }],
  })

  // Prevent infinite re-prompt loops
  if (input.stop_hook_active) return ALLOW

  // -----------------------------------------------------------------------
  // Per-task isolated review: if taskCompletionInProgress is set, the agent
  // just completed a task and review is pending. Dispatch an isolated
  // reviewer subprocess (claude --print) — the agent never touches the
  // review, ensuring no context pollution.
  // -----------------------------------------------------------------------
  const state = await bridgeCall(stateDir, "state.get", { sessionId }) as Record<string, unknown> | null
  // Per-task review pending: nudge the agent to dispatch it explicitly via
  // `./artisan run-review` (visible + awaited) rather than dispatching invisibly here.
  if (state?.taskCompletionInProgress) {
    return {
      stdout: null,
      stderr: "A completed task is awaiting review. Run `./artisan run-review` to dispatch the isolated per-task reviewer — it runs the review, submits the verdict, and prints the result. Do not proceed until it passes.",
      exitCode: 2,
    }
  }

  // Phase review pending: nudge the agent to dispatch it explicitly via
  // `./artisan run-review` (a visible, awaited Bash command) rather than dispatching
  // invisibly here on turn-end — which silently stalled when the turn didn't end the
  // way the hook expected, with no result and no notification.
  if (state?.phaseState === "REVIEW") {
    return {
      stdout: null,
      stderr: `At ${state.phase}/REVIEW. Run \`./artisan run-review\` to dispatch the isolated reviewer — it runs the review, submits the verdict, and prints whether the phase passed (→ USER_GATE) or needs revision (→ REVISE). Do not approve or proceed until it has run.`,
      exitCode: 2,
    }
  }

  // -----------------------------------------------------------------------
  // Robot-artisan auto-approval: when at USER_GATE with activeAgent
  // "robot-artisan", dispatch an isolated auto-approver subprocess instead
  // of waiting for human input.
  // -----------------------------------------------------------------------
  if (state?.phaseState === "USER_GATE" && state?.activeAgent === "robot-artisan") {
    const approvePrompt = await bridgeCall(stateDir, "task.getAutoApproveContext", { sessionId })
    if (approvePrompt && typeof approvePrompt === "string") {
      const projectDir = input.cwd ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
      const autoApproveToken = extractReviewToken(approvePrompt)
      if (!autoApproveToken) return ALLOW
      try {
        const result = await runOwnedReviewerCommand(approvePrompt, projectDir, "auto-approve")
        if (result.exitCode !== 0) throw new Error(`auto-approval command exited with code ${result.exitCode}${result.stderr.trim() ? ` | stderr: ${result.stderr.trim()}` : ""}`)
        const approveOutput = result.stdout
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_auto_approve",
          args: { review_output: approveOutput, review_token: autoApproveToken },
          context: { sessionId, directory: projectDir, invocation: "auto-approver" },
        })
        return {
          stdout: null,
          stderr: "Robot-artisan auto-approval completed. Continue with the workflow.",
          exitCode: 2,
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const failureOutput = JSON.stringify({
          approve: false,
          confidence: 0,
          reasoning: `Auto-approval subprocess failed: ${errMsg}`,
          feedback: buildRobotArtisanAutoApproveFailureFeedback(errMsg),
        })
        await bridgeCall(stateDir, "tool.execute", {
          name: "submit_auto_approve",
          args: { review_output: failureOutput, review_token: autoApproveToken },
          context: { sessionId, directory: projectDir, invocation: "auto-approver" },
        })
        return {
          stdout: null,
          stderr: "Robot-artisan auto-approval failed and was routed back to revision work. Continue autonomously.",
          exitCode: 2,
        }
      }
    }
  }

  const result = await bridgeCall(stateDir, "idle.check", { sessionId })

  if (!result) return ALLOW

  const idle = result as { action: string; message?: string }
  if (idle.action === "reprompt" || idle.action === "escalate") {
    return {
      stdout: null,
      stderr: idle.message ?? "Continue working on the current workflow task.",
      exitCode: 2,
    }
  }

  return ALLOW
}

// ---------------------------------------------------------------------------
// SessionStart handler
// ---------------------------------------------------------------------------

/**
 * SessionStart: Registers session and injects workflow prompt.
 *
 * - If disabled: no injection (exit 0)
 * - Registers session with the bridge
 * - Writes session_id to .active-session
 * - Returns workflow system prompt as additional context
 * - On "compact" source: re-injects state context
 */
export async function handleSessionStart(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: inject nothing (no context pollution) and,
  // critically, do NOT persist its throwaway session id as the active session —
  // doing so would clobber the authoring session's `.active-session` pointer and
  // make `artisan state` resolve the wrong (empty) session.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)

  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = input.session_id ?? "default"

  // Write session_id to .active-session for CLI to read
  persistActiveSessionId(stateDir, sessionId)

  // Register session with the bridge (no-op if already registered)
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  // On resume: user sent a message. If at USER_GATE, mark that the user has
  // responded so submit_feedback becomes allowed (structural gate enforcement).
  if (input.source === "resume") {
    await bridgeCall(stateDir, "message.process", {
      sessionId,
      parts: [{ type: "text", text: "(user resumed session)" }],
    })
  }

  // Build the workflow system prompt
  const prompt = await bridgeCall(stateDir, "prompt.build", { sessionId })
  if (!prompt || typeof prompt !== "string") return ALLOW

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: prompt,
      },
    }),
    stderr: null,
    exitCode: 0,
  }
}

// ---------------------------------------------------------------------------
// UserPromptSubmit handler
// ---------------------------------------------------------------------------

/**
 * UserPromptSubmit: relays the user's submitted prompt to the bridge as a
 * NON-synthetic message.
 *
 * This is the structural "a human responded" signal. At a workflow gate
 * (e.g. PLANNING/USER_GATE) the bridge flips `userGateMessageReceived` only for
 * a non-synthetic message (message.ts), which is what unblocks `submit_feedback`.
 * The Stop hook's message is synthetic and the SessionStart=resume relay only
 * fires on an actual session resume — so without this hook a continuous Claude
 * Code session never delivers user input to the bridge and NO USER_GATE can be
 * passed (neither approve nor revise). It also captures the intent baseline from
 * the first user message. We never alter the prompt (exit 0, no injection).
 */
export async function handleUserPromptSubmit(input: HookInput): Promise<HookOutput> {
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)
  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)
  await bridgeCall(stateDir, "lifecycle.sessionCreated", { sessionId })

  await bridgeCall(stateDir, "message.process", {
    sessionId,
    parts: [{ type: "text", text: input.prompt ?? "" }],
  })

  return ALLOW
}

// ---------------------------------------------------------------------------
// PreCompact handler
// ---------------------------------------------------------------------------

/**
 * PreCompact: Preserves workflow state through context compression.
 *
 * - If disabled: no injection (exit 0)
 * - Returns compaction context as additional context
 */
export async function handlePreCompact(input: HookInput): Promise<HookOutput> {
  // Isolated reviewer subprocess: inject nothing and don't clobber active-session.
  if (isReviewerSubprocess()) return ALLOW

  const stateDir = getStateDir(input)
  if (!isEnabled(stateDir)) return ALLOW

  const sessionId = resolveSessionId(input, stateDir)
  persistActiveSessionId(stateDir, sessionId)
  const context = await bridgeCall(stateDir, "prompt.compaction", { sessionId })
  if (!context || typeof context !== "string") return ALLOW

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: context,
      },
    }),
    stderr: null,
    exitCode: 0,
  }
}

// ---------------------------------------------------------------------------
// PostToolUse handler
// ---------------------------------------------------------------------------

/**
 * PostToolUse: Logging only. Always exits 0.
 */
export async function handlePostToolUse(_input: HookInput): Promise<HookOutput> {
  return ALLOW
}
