-- name: CreateRun :one
INSERT INTO runs (organization_id, project_id, environment_id, graph_id, type, trigger, status, budget, required_labels)
VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, COALESCE(@required_labels::text[], '{}')) RETURNING *;

-- name: GetRun :one
SELECT * FROM runs WHERE organization_id = $1 AND id = $2;

-- name: ListRuns :many
SELECT * FROM runs WHERE organization_id = $1 AND environment_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50;

-- name: RequeueExpiredRuns :exec
UPDATE runs SET
    status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
    finished_at = CASE WHEN attempts >= 3 THEN now() ELSE NULL END,
    runner_id = NULL, lease_expires_at = NULL, updated_at = now()
WHERE organization_id = $1 AND status = 'running' AND lease_expires_at < now();

-- name: ClaimNextRun :one
WITH next AS (
    SELECT r.id FROM runs r
    WHERE r.organization_id = $1 AND r.status = 'queued' AND r.required_labels <@ @runner_labels::text[]
      AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.environment_id = r.environment_id AND x.status = 'running')
    ORDER BY r.created_at, r.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE runs SET
    status = 'running', runner_id = $2, lease_expires_at = now() + interval '60 seconds',
    attempts = attempts + 1, started_at = COALESCE(started_at, now()), updated_at = now()
FROM next WHERE runs.id = next.id
RETURNING runs.*;

-- name: HeartbeatRun :one
UPDATE runs SET lease_expires_at = now() + interval '60 seconds', updated_at = now()
WHERE organization_id = $1 AND id = $2 AND runner_id = $3 AND status = 'running'
RETURNING *;

-- name: GetRunForRunner :one
SELECT * FROM runs WHERE organization_id = $1 AND id = $2 AND runner_id = $3;

-- name: CompleteRun :one
UPDATE runs SET status = $4, summary = $5, finished_at = now(), lease_expires_at = NULL, updated_at = now()
WHERE organization_id = $1 AND id = $2 AND runner_id = $3 AND status = 'running'
RETURNING *;

-- name: CancelRun :one
UPDATE runs SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL, updated_at = now()
WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')
RETURNING *;

-- name: InsertRunEvent :execrows
INSERT INTO run_events (run_id, attempt, seq, type, payload) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT DO NOTHING;

-- name: ListCoveredNodes :many
SELECT n.id, n.kind, n.fingerprint, n.label, n.app_roles, n.metadata, ARRAY_AGG(DISTINCT r.key ORDER BY r.key)::text[] AS requirement_keys
FROM nodes n
JOIN requirement_links l ON l.node_id = n.id
JOIN requirements r ON r.id = l.requirement_id
WHERE n.organization_id = $1 AND n.graph_id = $2
GROUP BY n.id
ORDER BY n.created_at, n.id;

-- name: ListCoveredNodesForSpec :many
SELECT n.id, n.kind, n.fingerprint, n.label, n.app_roles, n.metadata, ARRAY_AGG(DISTINCT r.key ORDER BY r.key)::text[] AS requirement_keys
FROM nodes n
JOIN requirement_links l ON l.node_id = n.id
JOIN requirements r ON r.id = l.requirement_id
WHERE n.organization_id = $1 AND n.graph_id = $2 AND r.spec_id = $3
GROUP BY n.id
ORDER BY n.created_at, n.id;

-- name: CreateRegressionRun :one
INSERT INTO runs (organization_id, project_id, environment_id, graph_id, type, trigger, status, budget, target_node_ids, required_labels)
VALUES ($1, $2, $3, $4, 'regression', $5, 'queued', $6, sqlc.narg('target_node_ids')::uuid[], COALESCE(@required_labels::text[], '{}')) RETURNING *;

-- name: GetLatestExplorationRunOfGraph :one
SELECT * FROM runs WHERE organization_id = $1 AND graph_id = $2 AND type = 'exploration' ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: CountExplorationRunsOfGraph :one
SELECT count(*)::int FROM runs WHERE organization_id = $1 AND graph_id = $2 AND type = 'exploration';

-- name: DetachRunsFromGraph :exec
UPDATE runs SET graph_id = NULL, updated_at = now() WHERE organization_id = $1 AND graph_id = $2;
