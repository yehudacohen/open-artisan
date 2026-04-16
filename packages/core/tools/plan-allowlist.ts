import { resolve } from "node:path"

export function extractApprovedFileAllowlist(planContent: string, cwd: string): string[] {
  const lines = planContent.split("\n")
  const collected: string[] = []
  let inAllowlist = false

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
    if (!rawPath || /^none$/i.test(rawPath)) continue
    collected.push(rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath))
  }

  return collected
}
