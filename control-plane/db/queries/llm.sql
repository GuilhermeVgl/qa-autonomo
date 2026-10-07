-- name: RecordUsage :exec
INSERT INTO llm_usage (organization_id, run_id, task, provider, model, tokens_in, tokens_out)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListUsage :many
SELECT * FROM llm_usage WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;
