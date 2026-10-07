-- name: GetBugByFingerprint :one
SELECT * FROM bugs WHERE organization_id = $1 AND project_id = $2 AND fingerprint = $3;

-- name: CreateBug :one
INSERT INTO bugs (organization_id, project_id, fingerprint, title, severity, requirement_id, node_id, node_fingerprint, first_seen_run_id, last_seen_run_id, category, security_check)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, COALESCE(sqlc.narg('category')::text, 'functional'), sqlc.narg('security_check')::text) RETURNING *;

-- name: MarkBugSeen :one
UPDATE bugs SET status = $3, last_seen_run_id = $4, fixed_in_run_id = NULL, updated_at = now()
WHERE organization_id = $1 AND id = $2 RETURNING *;

-- name: CreateOccurrence :exec
INSERT INTO bug_occurrences (organization_id, bug_id, run_id, run_step_id) VALUES ($1, $2, $3, $4)
ON CONFLICT (bug_id, run_step_id) DO NOTHING;

-- name: ListOpenBugsForNode :many
SELECT * FROM bugs
WHERE organization_id = $1 AND project_id = $2 AND node_fingerprint = $3
  AND category = 'functional' -- a passing screen says nothing about its security: each finding is fixed by its own check
  AND status IN ('new', 'confirmed', 'reopened') AND last_seen_run_id <> $4;

-- name: MarkBugFixed :exec
UPDATE bugs SET status = 'fixed', fixed_in_run_id = $3, updated_at = now() WHERE organization_id = $1 AND id = $2;

-- name: SetBugStatus :one
UPDATE bugs SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *;

-- name: GetBug :one
SELECT * FROM bugs WHERE organization_id = $1 AND id = $2;

-- name: ListBugs :many
SELECT * FROM bugs
WHERE organization_id = $1 AND project_id = $2 AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('category')::text IS NULL OR category = sqlc.narg('category')::text)
ORDER BY updated_at DESC, id DESC LIMIT 200;

-- name: ListBugOccurrences :many
SELECT o.id, o.run_id, o.run_step_id, o.created_at, r.type AS run_type, s.result, s.actual
FROM bug_occurrences o
JOIN runs r ON r.id = o.run_id
JOIN run_steps s ON s.id = o.run_step_id
WHERE o.organization_id = $1 AND o.bug_id = $2
ORDER BY o.created_at DESC, o.id DESC;

-- name: ListRequirementsForNode :many
-- The requirements of a screen, whichever user's node they were linked to: a defect on a route has one requirement for all
-- the users who reach it, so it is one bug and not one per user.
SELECT r.id, r.key, r.criticality
FROM nodes me
JOIN nodes n ON n.organization_id = me.organization_id AND n.graph_id = me.graph_id AND n.kind = me.kind AND n.label = me.label
JOIN requirement_links l ON l.node_id = n.id AND l.organization_id = me.organization_id
JOIN requirements r ON r.id = l.requirement_id
WHERE me.organization_id = $1 AND me.id = $2
GROUP BY r.id, r.key, r.criticality
ORDER BY CASE r.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, r.key;

-- name: ListBugsSeenInRun :many
SELECT DISTINCT b.* FROM bugs b JOIN bug_occurrences o ON o.bug_id = b.id
WHERE b.organization_id = $1 AND o.run_id = $2 ORDER BY b.id;

-- name: ListBugsFixedInRun :many
SELECT * FROM bugs WHERE organization_id = $1 AND fixed_in_run_id = $2 ORDER BY id;

-- name: RenameBugFingerprint :exec
UPDATE bugs SET fingerprint = $3, updated_at = now() WHERE organization_id = $1 AND id = $2;

-- name: ListBugUsers :many
-- Who a bug affects: the users of the nodes its occurrences happened on.
SELECT o.bug_id, COALESCE(n.app_roles[1], '')::text AS app_role
FROM bug_occurrences o
JOIN run_steps s ON s.id = o.run_step_id
LEFT JOIN nodes n ON n.id = s.node_id
WHERE o.organization_id = $1 AND o.bug_id = ANY(@bug_ids::uuid[])
GROUP BY o.bug_id, 2
ORDER BY o.bug_id, 2;
