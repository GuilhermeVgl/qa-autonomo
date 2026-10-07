-- name: UpsertStep :one
INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, input_masked, expected, actual, result, started_at, finished_at, security)
VALUES (@organization_id, @run_id, @client_key, @node_id, COALESCE(sqlc.narg('executor')::text, 'browser'), @input_masked, @expected, @actual, sqlc.narg('result'), sqlc.narg('started_at'), sqlc.narg('finished_at'), sqlc.narg('security')::jsonb)
ON CONFLICT (run_id, client_key) DO UPDATE SET
    node_id     = COALESCE(EXCLUDED.node_id, run_steps.node_id),
    executor    = COALESCE(sqlc.narg('executor')::text, run_steps.executor),
    expected    = CASE WHEN EXCLUDED.expected <> '' THEN EXCLUDED.expected ELSE run_steps.expected END,
    actual      = CASE WHEN EXCLUDED.actual <> '' THEN EXCLUDED.actual ELSE run_steps.actual END,
    input_masked = CASE WHEN EXCLUDED.input_masked <> '{}'::jsonb THEN EXCLUDED.input_masked ELSE run_steps.input_masked END,
    result      = COALESCE(EXCLUDED.result, run_steps.result),
    started_at  = COALESCE(run_steps.started_at, EXCLUDED.started_at),
    finished_at = COALESCE(EXCLUDED.finished_at, run_steps.finished_at),
    security    = COALESCE(EXCLUDED.security, run_steps.security),
    updated_at  = now()
RETURNING *;

-- name: CreateArtifact :one
INSERT INTO artifacts (organization_id, run_step_id, kind, storage_key, content_type, size)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (storage_key) DO UPDATE SET updated_at = now()
RETURNING *;

-- name: GetArtifact :one
SELECT * FROM artifacts WHERE organization_id = $1 AND id = $2;

-- name: ListStepsByNode :many
SELECT s.*, r.type AS run_type, r.status AS run_status, r.created_at AS run_created_at
FROM run_steps s JOIN runs r ON r.id = s.run_id
WHERE s.organization_id = $1 AND s.node_id = $2
ORDER BY s.created_at DESC, s.id DESC
LIMIT $3;

-- name: ListStepsByRun :many
SELECT * FROM run_steps WHERE organization_id = $1 AND run_id = $2 ORDER BY created_at, id;

-- name: ListArtifactsForSteps :many
SELECT * FROM artifacts WHERE organization_id = $1 AND run_step_id = ANY(@step_ids::uuid[]) ORDER BY created_at, id;

-- name: ListNodeRoles :many
SELECT id, app_roles FROM nodes WHERE organization_id = $1 AND id = ANY(@ids::uuid[]);

-- name: GetNodeThumbnail :one
SELECT thumbnail_key, thumbnail_content_type FROM nodes WHERE organization_id = $1 AND id = $2 AND thumbnail_key IS NOT NULL;

-- name: ListStepsPage :many
-- Steps of a run for the screen that reviews them: problems first, filtered by result and by user (the user of the node).
SELECT s.* FROM run_steps s LEFT JOIN nodes n ON n.id = s.node_id
WHERE s.organization_id = @organization_id AND s.run_id = @run_id
  AND (sqlc.narg('results')::text[] IS NULL OR COALESCE(s.result, 'running') = ANY(sqlc.narg('results')::text[]))
  AND (sqlc.narg('app_role')::text IS NULL OR COALESCE(n.app_roles[1], '') = sqlc.narg('app_role')::text)
  AND (sqlc.narg('security')::boolean IS NULL OR (s.security IS NOT NULL) = sqlc.narg('security')::boolean)
ORDER BY CASE WHEN s.result IN ('fail', 'error') THEN 0 WHEN s.result IS NULL THEN 1 ELSE 2 END, s.created_at, s.id
LIMIT @page_size OFFSET @page_offset;

-- name: CountStepsPage :one
SELECT count(*)::int FROM run_steps s LEFT JOIN nodes n ON n.id = s.node_id
WHERE s.organization_id = @organization_id AND s.run_id = @run_id
  AND (sqlc.narg('results')::text[] IS NULL OR COALESCE(s.result, 'running') = ANY(sqlc.narg('results')::text[]))
  AND (sqlc.narg('app_role')::text IS NULL OR COALESCE(n.app_roles[1], '') = sqlc.narg('app_role')::text)
  AND (sqlc.narg('security')::boolean IS NULL OR (s.security IS NOT NULL) = sqlc.narg('security')::boolean);

-- name: RunNodeResults :many
-- The worst verdict of each node in a run: what the flow view needs, without sending every step.
SELECT s.node_id,
  (CASE WHEN bool_or(s.result = 'fail') THEN 'fail'
        WHEN bool_or(s.result = 'error') THEN 'error'
        WHEN bool_or(s.result = 'pass') THEN 'pass'
        ELSE 'skipped' END)::text AS result
FROM run_steps s
WHERE s.organization_id = $1 AND s.run_id = $2 AND s.node_id IS NOT NULL AND s.result IS NOT NULL AND s.security IS NULL
GROUP BY s.node_id;
