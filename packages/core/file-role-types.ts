/**
 * file-role-types.ts — Public contract for classifying reviewed artifact files.
 */

/**
 * Review role assigned to an artifact file for phase-scoped review.
 */
export type ReviewedFileRole =
  | "contract-only"
  | "mixed-contract-module"
  | "executable-implementation"

/**
 * Public contract for a file role decision used by INTERFACES validation and prompts.
 */
export interface ReviewedFileRoleClassification {
  /** Absolute repository path submitted for review. */
  filePath: string
  /** Phase-scoped role assigned to the file. */
  role: ReviewedFileRole
  /** Public type/schema/interface surface that is in review scope. */
  publicContractSurface: string[]
  /** Executable behavior that is explicitly in scope for mixed contract modules. */
  executableBehaviorInScope: string[]
  /** Human-readable reason shown in review/validation messages. */
  reason: string
}

/**
 * Planning-approved metadata that permits a mixed contract module during INTERFACES.
 */
export interface MixedContractModuleApproval {
  filePath: string
  publicContractSurface: string[]
  executableBehaviorInScope: string[]
  approvedInPlan: true
}
