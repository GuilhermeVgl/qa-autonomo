-- name: CreateSchedule :one
INSERT INTO schedules (organization_id, project_id, environment_id, run_type, cron, next_run_at)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: ListSchedules :many
SELECT * FROM schedules WHERE organization_id = $1 AND environment_id = $2 ORDER BY created_at, id;

-- name: GetSchedule :one
SELECT * FROM schedules WHERE organization_id = $1 AND id = $2;

-- name: SetScheduleEnabled :one
UPDATE schedules SET enabled = $3, next_run_at = $4, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *;

-- name: DeleteSchedule :execrows
DELETE FROM schedules WHERE organization_id = $1 AND id = $2;

-- name: ClaimDueSchedules :many
SELECT * FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED;

-- name: AdvanceSchedule :exec
UPDATE schedules SET last_run_at = $2, next_run_at = $3, updated_at = now() WHERE id = $1;

-- name: HasActiveRun :one
SELECT EXISTS (SELECT 1 FROM runs WHERE environment_id = $1 AND type = $2 AND status IN ('queued', 'running'));
