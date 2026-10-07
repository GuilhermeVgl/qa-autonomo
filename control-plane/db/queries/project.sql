-- name: CreateProject :one
INSERT INTO projects (organization_id, name) VALUES ($1, $2) RETURNING *;

-- name: GetProject :one
SELECT * FROM projects WHERE organization_id = $1 AND id = $2;

-- name: ListProjects :many
SELECT * FROM projects WHERE organization_id = $1 ORDER BY created_at, id;
