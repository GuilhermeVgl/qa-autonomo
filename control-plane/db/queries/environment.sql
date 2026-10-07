-- name: CreateEnvironment :one
INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts, destructive_policy, is_production, device, kind, terminal_binary, terminal_image)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE(NULLIF(@kind::text, ''), 'web'), @terminal_binary, @terminal_image) RETURNING *;

-- name: GetEnvironment :one
SELECT * FROM environments WHERE organization_id = $1 AND id = $2;

-- name: ListEnvironments :many
SELECT * FROM environments WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at, id;

-- name: UpsertCredential :one
INSERT INTO credentials (organization_id, environment_id, app_role, kind, payload_encrypted)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (environment_id, app_role, kind)
DO UPDATE SET payload_encrypted = EXCLUDED.payload_encrypted, updated_at = now()
RETURNING id, environment_id, app_role, kind, updated_at;

-- name: ListCredentials :many
SELECT id, environment_id, app_role, kind, updated_at
FROM credentials WHERE organization_id = $1 AND environment_id = $2 ORDER BY app_role, kind;

-- name: GetCredentialPayload :one
SELECT payload_encrypted FROM credentials
WHERE organization_id = $1 AND environment_id = $2 AND app_role = $3 AND kind = $4;

-- name: ListCredentialSecrets :many
SELECT app_role, kind, payload_encrypted FROM credentials
WHERE organization_id = $1 AND environment_id = $2 ORDER BY app_role, kind;

-- name: GetEnvironmentByName :one
SELECT * FROM environments WHERE organization_id = $1 AND project_id = $2 AND name = $3;
