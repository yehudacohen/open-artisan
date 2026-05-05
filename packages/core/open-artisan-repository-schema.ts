/**
 * open-artisan-repository-schema.ts — provider-neutral runtime DB schema types.
 */

export const OPEN_ARTISAN_ROADMAP_DOCUMENT_SCHEMA_VERSION = 1
export const DEFAULT_OPEN_ARTISAN_DB_SCHEMA = "open_artisan"
export const DEFAULT_OPEN_ARTISAN_DB_FILE_NAME = "open-artisan.pg"

export const OPEN_ARTISAN_DB_TABLES = [
  "database_operation_locks",
  "roadmap_items",
  "roadmap_edges",
  "execution_slices",
  "execution_slice_items",
  "workflows",
  "workflow_events",
  "workflow_roadmap_links",
  "artifacts",
  "artifact_versions",
  "artifact_approvals",
  "artifact_roadmap_links",
  "tasks",
  "task_dependencies",
  "task_owned_files",
  "task_expected_tests",
  "task_roadmap_links",
  "task_reviews",
  "phase_reviews",
  "review_observations",
  "patch_suggestions",
  "patch_applications",
  "agent_leases",
  "file_claims",
  "worktree_observations",
  "human_gates",
  "fast_forward_records",
] as const

export interface OpenArtisanDatabase {
  database_operation_locks: {
    lock_key: string
    owner_id: string
    lease_expires_at: string
    created_at: string
    updated_at: string
  }
  schema_migrations: {
    version: number
    applied_at: string
  }
  roadmap_items: {
    id: string
    feature_name: string | null
    status: string
    priority: number
    record: unknown
    created_at: string
    updated_at: string
  }
  roadmap_edges: {
    edge_key: string
    from_item_id: string
    to_item_id: string
    kind: string
    record: unknown
  }
  execution_slices: {
    id: string
    feature_name: string | null
    status: string
    record: unknown
    created_at: string
    updated_at: string
  }
  execution_slice_items: {
    slice_id: string
    roadmap_item_id: string
  }
  workflows: {
    id: string
    feature_name: string
    mode: string
    phase: string
    phase_state: string
    record: unknown
    state_snapshot: unknown | null
    created_at: string
    updated_at: string
  }
  workflow_events: {
    id: string
    workflow_id: string
    created_at: string
    record: unknown
  }
  workflow_roadmap_links: {
    workflow_id: string
    roadmap_item_id: string
  }
  artifacts: {
    id: string
    workflow_id: string
    artifact_key: string
    current_version_id: string | null
    record: unknown
    created_at: string
    updated_at: string
  }
  artifact_versions: {
    id: string
    artifact_id: string
    content_hash: string
    record: unknown
    created_at: string
  }
  artifact_approvals: {
    id: string
    artifact_version_id: string
    record: unknown
    created_at: string
  }
  artifact_roadmap_links: {
    artifact_id: string
    roadmap_item_id: string
  }
  tasks: {
    id: string
    workflow_id: string
    task_key: string
    status: string
    record: unknown
    created_at: string
    updated_at: string
  }
  task_dependencies: {
    workflow_id: string
    from_task_id: string
    to_task_id: string
  }
  task_owned_files: {
    task_id: string
    path: string
  }
  task_expected_tests: {
    task_id: string
    path: string
  }
  task_roadmap_links: {
    task_id: string
    roadmap_item_id: string
  }
  task_reviews: {
    id: string
    workflow_id: string
    task_id: string
    created_at: string
    record: unknown
  }
  phase_reviews: {
    id: string
    workflow_id: string
    phase: string
    created_at: string
    record: unknown
  }
  review_observations: {
    id: string
    review_id: string
    kind: string
    record: unknown
  }
  patch_suggestions: {
    id: string
    workflow_id: string
    status: string
    record: unknown
    created_at: string
    updated_at: string
  }
  patch_applications: {
    id: string
    patch_suggestion_id: string
    record: unknown
    created_at: string
  }
  agent_leases: {
    id: string
    workflow_id: string
    session_id: string
    task_id: string | null
    expires_at: string
    record: unknown
    created_at: string
  }
  file_claims: {
    id: string
    agent_lease_id: string
    path: string
    mode: string
    record: unknown
    created_at: string
  }
  worktree_observations: {
    id: string
    workflow_id: string
    path: string
    classification: string
    record: unknown
    created_at: string
  }
  human_gates: {
    id: string
    workflow_id: string
    task_id: string
    resolved: boolean
    record: unknown
    created_at: string
    resolved_at: string | null
  }
  fast_forward_records: {
    id: string
    workflow_id: string
    record: unknown
    created_at: string
  }
}
