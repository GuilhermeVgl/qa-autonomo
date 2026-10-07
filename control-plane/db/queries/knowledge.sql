-- name: CreateKnowledge :one
INSERT INTO knowledge_entries (organization_id, project_id, content, origin, origin_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: ListKnowledge :many
SELECT * FROM knowledge_entries WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at, id;
