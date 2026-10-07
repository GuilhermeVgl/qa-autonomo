-- name: CountStepsByResult :many
SELECT COALESCE(result, 'running')::text AS result, COUNT(*)::int AS n
FROM run_steps WHERE organization_id = $1 AND run_id = $2 AND security IS NULL GROUP BY 1;

-- name: ListRequirementOutcomes :many
SELECT r.key, r.text, r.criticality,
  (CASE WHEN bool_or(s.result = 'fail') THEN 'fail'
        WHEN bool_or(s.result = 'error') THEN 'error'
        WHEN bool_or(s.result = 'pass') THEN 'pass'
        ELSE 'skipped' END)::text AS outcome
FROM run_steps s
JOIN requirement_links l ON l.node_id = s.node_id
JOIN requirements r ON r.id = l.requirement_id
WHERE s.organization_id = $1 AND s.run_id = $2 AND s.security IS NULL AND (sqlc.narg('spec_id')::uuid IS NULL OR r.spec_id = sqlc.narg('spec_id')::uuid)
GROUP BY r.key, r.text, r.criticality
ORDER BY r.key;

-- name: RunLLMCost :one
SELECT COUNT(*)::int AS calls, COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in,
       COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out, COALESCE(SUM(cost), 0)::float8 AS cost
FROM llm_usage WHERE organization_id = $1 AND run_id = $2;

-- name: CountStepsByUser :many
-- Who was tested: the user of a step is the one the node belongs to (a node is per user, see the fingerprint).
SELECT COALESCE(n.app_roles[1], '')::text AS app_role, COALESCE(s.result, 'running')::text AS result, COUNT(*)::int AS n
FROM run_steps s LEFT JOIN nodes n ON n.id = s.node_id
WHERE s.organization_id = $1 AND s.run_id = $2 AND s.security IS NULL
GROUP BY 1, 2;

-- name: ListRequirementOutcomesByUser :many
SELECT r.key, COALESCE(n.app_roles[1], '')::text AS app_role,
  (CASE WHEN bool_or(s.result = 'fail') THEN 'fail'
        WHEN bool_or(s.result = 'error') THEN 'error'
        WHEN bool_or(s.result = 'pass') THEN 'pass'
        ELSE 'skipped' END)::text AS outcome
FROM run_steps s
JOIN nodes n ON n.id = s.node_id
JOIN requirement_links l ON l.node_id = s.node_id
JOIN requirements r ON r.id = l.requirement_id
WHERE s.organization_id = $1 AND s.run_id = $2 AND s.security IS NULL AND (sqlc.narg('spec_id')::uuid IS NULL OR r.spec_id = sqlc.narg('spec_id')::uuid)
GROUP BY r.key, 2;

-- name: CountSecurityChecks :many
-- What the security checks of a run found: how many ran and what each severity of failure came to.
SELECT COALESCE(s.result, 'running')::text AS result, COALESCE(s.security->>'severity', 'normal')::text AS severity, COUNT(*)::int AS n
FROM run_steps s
WHERE s.organization_id = $1 AND s.run_id = $2 AND s.security IS NOT NULL
GROUP BY 1, 2;
