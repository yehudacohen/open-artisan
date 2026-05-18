export type GuardedPatchResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

export interface GuardedPatchHunk {
  oldLines: string[]
  newLines: string[]
}

export type GuardedPatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "update"; path: string; hunks: GuardedPatchHunk[]; moveTo?: string }
  | { type: "delete"; path: string }

export interface ParsedGuardedPatch {
  operations: GuardedPatchOperation[]
  targetPaths: string[]
}

export interface GuardedPatchChange {
  path: string
  oldContent: string | null
  newContent: string | null
}

export interface UnifiedDiffSummary {
  diff: string
  additions: number
  removals: number
}

function normalizePatchText(patchText: string): string {
  return patchText.includes("\\n") && !patchText.includes("\n")
    ? patchText.replace(/\\r\\n|\\n/g, "\n")
    : patchText
}

function parsePathHeader(line: string, kind: "Add File" | "Update File" | "Delete File" | "Move to"): string | null {
  const match = line.match(new RegExp(`^\\*\\*\\*\\s+${kind}:\\s+(.+)\\s*$`))
  const rawPath = match?.[1]?.trim().replace(/^['"]|['"]$/g, "")
  return rawPath || null
}

function isFileHeader(line: string): boolean {
  return /^\*\*\*\s+(?:Add File|Update File|Delete File):\s+/.test(line)
}

function isPatchBoundary(line: string): boolean {
  return /^\*\*\*\s+(?:Begin Patch|End Patch)\s*$/.test(line)
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function parseHunk(lines: string[], path: string): GuardedPatchResult<GuardedPatchHunk> {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("+")) {
      newLines.push(line.slice(1))
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      const context = line.slice(1)
      oldLines.push(context)
      newLines.push(context)
    } else if (line.startsWith("\\")) {
      continue
    } else if (line === "") {
      oldLines.push("")
      newLines.push("")
    } else {
      return { success: false, error: `Malformed hunk for ${path}: patch lines must start with space, +, or -.` }
    }
  }
  if (oldLines.length === 0) {
    return { success: false, error: `Malformed hunk for ${path}: update hunks require at least one existing or context line.` }
  }
  return { success: true, data: { oldLines, newLines } }
}

export function parseGuardedPatch(patchText: string): GuardedPatchResult<ParsedGuardedPatch> {
  const normalized = normalizePatchText(patchText)
  const rawLines = normalized.split(/\r?\n/)
  const start = rawLines.findIndex((line) => line.trim().length > 0)
  const end = rawLines.findLastIndex((line) => line.trim().length > 0)
  if (start === -1 || end === -1) return { success: false, error: "Patch text is empty." }
  if (rawLines[start] !== "*** Begin Patch") return { success: false, error: "Patch must start with *** Begin Patch." }
  if (rawLines[end] !== "*** End Patch") return { success: false, error: "Patch must end with *** End Patch." }

  const operations: GuardedPatchOperation[] = []
  const targetPaths: string[] = []
  let index = start + 1
  while (index < end) {
    const line = rawLines[index]!
    if (line.trim().length === 0) {
      index++
      continue
    }
    if (isPatchBoundary(line)) return { success: false, error: `Unexpected patch boundary at line ${index + 1}.` }

    const addPath = parsePathHeader(line, "Add File")
    if (addPath) {
      index++
      const contentLines: string[] = []
      while (index < end && !isFileHeader(rawLines[index]!)) {
        const contentLine = rawLines[index]!
        if (!contentLine.startsWith("+")) return { success: false, error: `Add File ${addPath} lines must start with +.` }
        contentLines.push(contentLine.slice(1))
        index++
      }
      operations.push({ type: "add", path: addPath, content: contentLines.join("\n") })
      pushUnique(targetPaths, addPath)
      continue
    }

    const updatePath = parsePathHeader(line, "Update File")
    if (updatePath) {
      index++
      const moveTo = index < end ? parsePathHeader(rawLines[index]!, "Move to") : null
      if (moveTo) index++
      const hunks: GuardedPatchHunk[] = []
      while (index < end && !isFileHeader(rawLines[index]!)) {
        if (!rawLines[index]!.startsWith("@@")) {
          return { success: false, error: `Update File ${updatePath} requires @@ hunk headers.` }
        }
        index++
        const hunkLines: string[] = []
        while (index < end && !rawLines[index]!.startsWith("@@") && !isFileHeader(rawLines[index]!)) {
          hunkLines.push(rawLines[index]!)
          index++
        }
        const parsedHunk = parseHunk(hunkLines, updatePath)
        if (!parsedHunk.success) return parsedHunk
        hunks.push(parsedHunk.data)
      }
      if (hunks.length === 0) return { success: false, error: `Update File ${updatePath} must include at least one hunk.` }
      operations.push(moveTo ? { type: "update", path: updatePath, moveTo, hunks } : { type: "update", path: updatePath, hunks })
      pushUnique(targetPaths, updatePath)
      if (moveTo) pushUnique(targetPaths, moveTo)
      continue
    }

    const deletePath = parsePathHeader(line, "Delete File")
    if (deletePath) {
      index++
      operations.push({ type: "delete", path: deletePath })
      pushUnique(targetPaths, deletePath)
      continue
    }

    return { success: false, error: `Unsupported patch line ${index + 1}: ${line}` }
  }

  if (operations.length === 0) return { success: false, error: "Patch contains no file operations." }
  return { success: true, data: { operations, targetPaths } }
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function joinContentLines(lines: string[], hadFinalNewline: boolean): string {
  if (lines.length === 0) return hadFinalNewline ? "\n" : ""
  return `${lines.join("\n")}${hadFinalNewline ? "\n" : ""}`
}

function findSequence(lines: string[], sequence: string[], fromIndex: number): number {
  if (sequence.length === 0) return fromIndex
  for (let index = fromIndex; index <= lines.length - sequence.length; index++) {
    let matches = true
    for (let offset = 0; offset < sequence.length; offset++) {
      if (lines[index + offset] !== sequence[offset]) {
        matches = false
        break
      }
    }
    if (matches) return index
  }
  return -1
}

function applyHunks(content: string, hunks: GuardedPatchHunk[], path: string): GuardedPatchResult<string> {
  const hadFinalNewline = content.endsWith("\n")
  const lines = splitContentLines(content)
  let cursor = 0
  for (const hunk of hunks) {
    const index = findSequence(lines, hunk.oldLines, cursor)
    if (index === -1) return { success: false, error: `Patch hunk did not match ${path}.` }
    lines.splice(index, hunk.oldLines.length, ...hunk.newLines)
    cursor = index + hunk.newLines.length
  }
  return { success: true, data: joinContentLines(lines, hadFinalNewline) }
}

export function applyParsedGuardedPatch(
  parsed: ParsedGuardedPatch,
  initialContents: Map<string, string | null>,
): GuardedPatchResult<GuardedPatchChange[]> {
  const finalContents = new Map<string, string | null>()
  const touchedPaths: string[] = []

  const readCurrent = (path: string): string | null => {
    if (finalContents.has(path)) return finalContents.get(path) ?? null
    return initialContents.get(path) ?? null
  }
  const writeCurrent = (path: string, content: string | null): void => {
    if (!touchedPaths.includes(path)) touchedPaths.push(path)
    finalContents.set(path, content)
  }

  for (const operation of parsed.operations) {
    if (operation.type === "add") {
      if (readCurrent(operation.path) !== null) return { success: false, error: `Cannot add ${operation.path}: file already exists.` }
      writeCurrent(operation.path, operation.content)
      continue
    }

    if (operation.type === "delete") {
      if (readCurrent(operation.path) === null) return { success: false, error: `Cannot delete ${operation.path}: file does not exist.` }
      writeCurrent(operation.path, null)
      continue
    }

    const current = readCurrent(operation.path)
    if (current === null) return { success: false, error: `Cannot update ${operation.path}: file does not exist.` }
    const updated = applyHunks(current, operation.hunks, operation.path)
    if (!updated.success) return updated
    if (operation.moveTo) {
      if (operation.moveTo !== operation.path && readCurrent(operation.moveTo) !== null) {
        return { success: false, error: `Cannot move ${operation.path} to ${operation.moveTo}: destination already exists.` }
      }
      writeCurrent(operation.path, null)
      writeCurrent(operation.moveTo, updated.data)
    } else {
      writeCurrent(operation.path, updated.data)
    }
  }

  const changes = touchedPaths
    .map((path) => ({ path, oldContent: initialContents.get(path) ?? null, newContent: finalContents.get(path) ?? null }))
    .filter((change) => change.oldContent !== change.newContent)
  return { success: true, data: changes }
}

export function applyGuardedPatch(
  patchText: string,
  initialContents: Map<string, string | null>,
): GuardedPatchResult<{ parsed: ParsedGuardedPatch; changes: GuardedPatchChange[] }> {
  const parsed = parseGuardedPatch(patchText)
  if (!parsed.success) return parsed
  const changes = applyParsedGuardedPatch(parsed.data, initialContents)
  if (!changes.success) return changes
  return { success: true, data: { parsed: parsed.data, changes: changes.data } }
}

export function buildUnifiedDiff(oldContent: string | null, newContent: string | null, filePath: string): UnifiedDiffSummary {
  if (oldContent === newContent) return { diff: "", additions: 0, removals: 0 }
  const oldLines = oldContent === null ? [] : splitContentLines(oldContent)
  const newLines = newContent === null ? [] : splitContentLines(newContent)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++

  const contextBefore = oldLines.slice(Math.max(0, prefix - 3), prefix)
  const contextAfter = oldLines.slice(oldLines.length - suffix, Math.min(oldLines.length, oldLines.length - suffix + 3))
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const oldStart = oldLines.length === 0 ? 0 : Math.max(1, prefix - contextBefore.length + 1)
  const newStart = newLines.length === 0 ? 0 : Math.max(1, prefix - contextBefore.length + 1)
  const oldSpan = contextBefore.length + removed.length + contextAfter.length
  const newSpan = contextBefore.length + added.length + contextAfter.length
  const diffLines = [
    `--- ${oldContent === null ? "/dev/null" : `a/${filePath}`}`,
    `+++ ${newContent === null ? "/dev/null" : `b/${filePath}`}`,
    `@@ -${oldStart},${oldSpan} +${newStart},${newSpan} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ]
  return { diff: diffLines.join("\n"), additions: added.length, removals: removed.length }
}

export function buildGuardedChangeSummary(verb: string, displayPath: string, diffs: UnifiedDiffSummary[]): string {
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const removals = diffs.reduce((sum, diff) => sum + diff.removals, 0)
  const diffText = diffs.map((diff) => diff.diff).filter(Boolean).join("\n")
  const lines = [`${verb} ${displayPath}.`, `Additions: ${additions}`, `Removals: ${removals}`]
  if (diffText) lines.push("", "```diff", diffText, "```")
  return lines.join("\n")
}
