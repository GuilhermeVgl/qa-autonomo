-- name: UpsertUser :one
INSERT INTO users (organization_id, email, oidc_subject) VALUES ($1, $2, $3)
ON CONFLICT (organization_id, oidc_subject)
DO UPDATE SET email = EXCLUDED.email, updated_at = now()
RETURNING *;

-- name: EnsureMembership :exec
INSERT INTO memberships (organization_id, user_id, role)
VALUES (
    @organization_id, @user_id,
    CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE organization_id = @organization_id)
         THEN 'member' ELSE 'owner' END
)
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- name: GetPrincipalBySubject :one
SELECT u.id AS user_id, u.organization_id, u.email, m.role
FROM users u
JOIN memberships m ON m.user_id = u.id AND m.organization_id = u.organization_id
WHERE u.organization_id = $1 AND u.oidc_subject = $2;
