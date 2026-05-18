import { relative, resolve } from "node:path"

export interface NormalizeWorkflowPathOptions {
  allowOutsideProject?: boolean
}

function cleanWorkflowPath(path: string): string {
  return path.trim().replace(/^['"`]|['"`]$/g, "").replace(/\\/g, "/")
}

export function isPathInsideProject(path: string, cwd: string): boolean {
  const projectRoot = resolve(cwd)
  const rel = relative(projectRoot, path)
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")
}

export function normalizeWorkflowPath(
  path: string,
  cwd: string,
  options: NormalizeWorkflowPathOptions = {},
): string | null {
  const cleaned = cleanWorkflowPath(path)
  if (!cleaned) return null
  const projectRoot = resolve(cwd)
  const absolute = cleaned.startsWith("/") ? resolve(cleaned) : resolve(projectRoot, cleaned)
  if (options.allowOutsideProject === false && !isPathInsideProject(absolute, projectRoot)) return null
  return absolute
}

export function normalizeWorkflowPaths(
  paths: string[] | undefined,
  cwd: string,
  options: NormalizeWorkflowPathOptions = {},
): string[] {
  const normalized = (paths ?? [])
    .map((path) => normalizeWorkflowPath(path, cwd, options))
    .filter((path): path is string => Boolean(path))
  return Array.from(new Set(normalized))
}

export function findInvalidWorkflowPaths(
  paths: string[] | undefined,
  cwd: string,
  options: NormalizeWorkflowPathOptions = {},
): string[] {
  return Array.from(new Set((paths ?? [])
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => normalizeWorkflowPath(path, cwd, options) === null)))
}
