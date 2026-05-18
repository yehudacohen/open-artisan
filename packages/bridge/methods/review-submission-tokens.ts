import { randomBytes } from "node:crypto"

import type { BridgeContext } from "../server"
import { REVIEW_SUBMISSION_TOKEN_BYTES, REVIEW_SUBMISSION_TOKEN_TTL_MS } from "../../core/constants"

export type ReviewSubmissionKind = "task" | "phase" | "auto-approve"

function invalidTokenMessage(kind: ReviewSubmissionKind): string {
  return kind === "auto-approve"
    ? "Invalid or expired auto-approver token. Request a fresh auto-approval context and retry."
    : "Invalid or expired isolated reviewer token. Request a fresh review context and retry."
}

function mismatchTokenMessage(kind: ReviewSubmissionKind): string {
  return kind === "auto-approve"
    ? "Auto-approver token does not match the pending gate. Request a fresh auto-approval context and retry."
    : "Isolated reviewer token does not match the pending review. Request a fresh review context and retry."
}

function cleanupExpiredReviewTokens(ctx: BridgeContext): void {
  const tokens = ctx.reviewSubmissionTokens
  if (!tokens) return
  const now = Date.now()
  for (const [token, record] of tokens.entries()) {
    if (record.expiresAt <= now) tokens.delete(token)
  }
}

export function issueReviewSubmissionToken(
  ctx: BridgeContext,
  sessionId: string,
  kind: ReviewSubmissionKind,
  subject: string,
  artifactHash?: string | null,
): string {
  cleanupExpiredReviewTokens(ctx)
  const token = randomBytes(REVIEW_SUBMISSION_TOKEN_BYTES).toString("hex")
  const tokens = ctx.reviewSubmissionTokens ?? new Map()
  tokens.set(token, {
    sessionId,
    kind,
    subject,
    expiresAt: Date.now() + REVIEW_SUBMISSION_TOKEN_TTL_MS,
    ...(artifactHash ? { artifactHash } : {}),
  })
  ctx.reviewSubmissionTokens = tokens
  return token
}

export function consumeReviewSubmissionToken(
  ctx: BridgeContext,
  token: string,
  sessionId: string,
  kind: ReviewSubmissionKind,
  subject: string,
  consume = true,
): { error: string | null; artifactHash: string | null } {
  cleanupExpiredReviewTokens(ctx)
  const record = ctx.reviewSubmissionTokens?.get(token)
  if (!record) return { error: invalidTokenMessage(kind), artifactHash: null }
  if (record.sessionId !== sessionId || record.kind !== kind || record.subject !== subject) {
    return { error: mismatchTokenMessage(kind), artifactHash: null }
  }
  if (consume) ctx.reviewSubmissionTokens?.delete(token)
  return { error: null, artifactHash: record.artifactHash ?? null }
}
