-- name: CreateAPIToken :one
INSERT INTO api_tokens (organization_id, project_id, name, token_hash, scopes, created_by)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: GetAPITokenByHash :one
SELECT * FROM api_tokens WHERE token_hash = $1;

-- name: TouchAPIToken :exec
UPDATE api_tokens SET last_used_at = now() WHERE id = $1;

-- name: ListAPITokens :many
SELECT * FROM api_tokens WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at, id;

-- name: DeleteAPIToken :execrows
DELETE FROM api_tokens WHERE organization_id = $1 AND id = $2;

-- name: GetAPIToken :one
SELECT * FROM api_tokens WHERE organization_id = $1 AND id = $2;
