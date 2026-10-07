-- name: CreateRunner :one
INSERT INTO runners (organization_id, name, token_hash, labels, version) VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: GetRunnerByTokenHash :one
SELECT * FROM runners WHERE token_hash = $1;

-- name: TouchRunner :exec
UPDATE runners SET last_seen_at = now() WHERE id = $1;
