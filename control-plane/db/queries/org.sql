-- name: EnsureOrganization :one
INSERT INTO organizations (name, slug) VALUES ($1, $2)
ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
RETURNING *;
