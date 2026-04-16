import { resolve } from "node:path"

export function extractApprovedFileAllowlist(planContent: string, cwd: string): string[] {
  const lines = planContent.split("\n")
  const collected: string[] = []
  let inAllowlist = false

  const pushCandidate = (candidate: string): void => {
    const normalized = candidate.trim()
    if (!normalized || /^none$/i.test(normalized)) return
    if (normalized.endsWith(":")) return
    if (/\s/.test(normalized)) return
    if (!/^[./`A-Za-z0-9_-]/.test(normalized)) return
    const unquoted = normalized.replace(/^`(.+)`$/, "$1")
    collected.push(unquoted.startsWith("/") ? unquoted : resolve(cwd, unquoted))
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const normalizedHeading = trimmed.replace(/^#{1,6}\s+/, "")
    const lower = normalizedHeading.toLowerCase()

    if (!inAllowlist) {
      if (
        lower === "allowlist" ||
        lower === "file allowlist:" ||
        lower === "allowlist:" ||
        lower === "narrow allowlist" ||
        lower === "narrow allowlist:" ||
        lower === "minimal incremental file allowlist" ||
        lower === "minimal incremental file allowlist:"
      ) {
        inAllowlist = true
      }
      continue
    }

    if (trimmed === "") {
      if (collected.length > 0) break
      continue
    }

    if (/^(#{1,6}\s|[A-Za-z].*:$)/.test(trimmed) && !trimmed.startsWith("- ")) {
      break
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed)
    if (!bulletMatch) {
      if (collected.length > 0) break
      continue
    }

    const rawPath = bulletMatch[1]!.trim()
    const inlineCodeMatches = Array.from(rawPath.matchAll(/`([^`]+)`/g), (match) => match[1]!.trim())
    if (inlineCodeMatches.length > 0) {
      for (const candidate of inlineCodeMatches) pushCandidate(candidate)
      continue
    }
    pushCandidate(rawPath)
  }

  return collected
}
