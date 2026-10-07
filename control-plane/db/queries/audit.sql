-- name: RecordAudit :exec
INSERT INTO audit_log (organization_id, actor, action, target, payload)
VALUES ($1, $2, $3, $4, $5);

-- name: ListAudit :many
SELECT * FROM audit_log WHERE organization_id = $1 ORDER BY at DESC, id DESC LIMIT $2;
