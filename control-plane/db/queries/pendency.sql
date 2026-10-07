-- name: GetRequirementByID :one
SELECT * FROM requirements WHERE organization_id = $1 AND id = $2;

-- name: DeleteAgentLinks :exec
DELETE FROM requirement_links l
WHERE l.organization_id = $1 AND l.source = 'agent'
  AND l.requirement_id IN (SELECT r.id FROM requirements r WHERE r.spec_id = $2)
  AND l.node_id IN (SELECT n.id FROM nodes n WHERE n.graph_id = $3);

-- name: UpsertLink :exec
INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (requirement_id, node_id) DO UPDATE SET
    confidence = CASE WHEN requirement_links.source = 'human' THEN requirement_links.confidence ELSE EXCLUDED.confidence END,
    source = CASE WHEN requirement_links.source = 'human' THEN 'human' ELSE EXCLUDED.source END,
    updated_at = now();

-- name: ListLinksForSpecAndGraph :many
SELECT l.id, l.requirement_id, l.node_id, l.confidence, l.source
FROM requirement_links l
JOIN requirements r ON r.id = l.requirement_id
JOIN nodes n ON n.id = l.node_id
WHERE l.organization_id = $1 AND r.spec_id = $2 AND n.graph_id = $3
ORDER BY r.key, l.id;

-- name: CreatePendency :one
INSERT INTO pendencies (organization_id, run_id, requirement_id, node_id, question)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: HasOpenPendency :one
SELECT EXISTS (SELECT 1 FROM pendencies WHERE organization_id = $1 AND requirement_id = $2 AND status = 'open');

-- name: GetPendency :one
SELECT * FROM pendencies WHERE organization_id = $1 AND id = $2;

-- name: ListPendenciesBySpec :many
SELECT p.* FROM pendencies p
JOIN requirements r ON r.id = p.requirement_id
WHERE p.organization_id = $1 AND r.spec_id = $2
ORDER BY p.created_at, p.id;

-- name: AnswerPendency :one
UPDATE pendencies SET status = 'answered', answer = $3, answered_by = $4, updated_at = now()
WHERE organization_id = $1 AND id = $2 AND status = 'open' RETURNING *;

-- name: DismissPendency :one
UPDATE pendencies SET status = 'dismissed', updated_at = now()
WHERE organization_id = $1 AND id = $2 AND status = 'open' RETURNING *;

-- name: DismissOpenForLinkedRequirements :exec
UPDATE pendencies p SET status = 'dismissed', updated_at = now()
WHERE p.organization_id = $1 AND p.status = 'open'
  AND p.requirement_id IN (SELECT r.id FROM requirements r WHERE r.spec_id = $2)
  AND EXISTS (SELECT 1 FROM requirement_links l WHERE l.requirement_id = p.requirement_id);

-- name: ListUnlinkedRequirements :many
SELECT r.* FROM requirements r
WHERE r.organization_id = $1 AND r.spec_id = $2
  AND NOT EXISTS (SELECT 1 FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE l.requirement_id = r.id AND n.graph_id = $3)
ORDER BY r.key;
