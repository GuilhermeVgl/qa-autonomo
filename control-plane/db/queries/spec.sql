-- name: NextSpecVersion :one
SELECT (COALESCE(MAX(version), 0) + 1)::int FROM specs WHERE organization_id = $1 AND project_id = $2;

-- name: CreateSpec :one
INSERT INTO specs (organization_id, project_id, version, source_type, title, extracted_text, environment_id)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.narg('environment_id')) RETURNING *;

-- name: GetSpec :one
SELECT * FROM specs WHERE organization_id = $1 AND id = $2;

-- name: ListSpecs :many
SELECT * FROM specs WHERE organization_id = $1 AND project_id = $2 ORDER BY version DESC;

-- name: GetLatestSpec :one
-- A spec written by people (text, document, OpenAPI): the generated one is never "the spec" of the project.
SELECT * FROM specs WHERE organization_id = $1 AND project_id = $2 AND source_type <> 'auto' ORDER BY version DESC LIMIT 1;

-- name: CreateRequirement :one
INSERT INTO requirements (organization_id, spec_id, key, text, criticality, status)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: ListRequirements :many
SELECT * FROM requirements WHERE organization_id = $1 AND spec_id = $2 ORDER BY key;

-- name: ListProjectEnvironmentIDs :many
SELECT id FROM environments WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at, id;

-- name: GetLatestAutoSpec :one
-- The automatic spec of one environment: each environment has its own, because each has its own map.
SELECT * FROM specs WHERE organization_id = $1 AND environment_id = $2 AND source_type = 'auto' ORDER BY version DESC LIMIT 1;

-- name: UpdateSpecTitle :one
UPDATE specs SET title = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *;

-- name: TouchSpec :exec
UPDATE specs SET updated_at = now() WHERE organization_id = $1 AND id = $2;

-- name: GetRequirement :one
SELECT * FROM requirements WHERE organization_id = $1 AND id = $2;

-- name: UpdateRequirement :one
UPDATE requirements SET text = $3, criticality = $4, status = $5, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *;

-- name: DeleteLinksOfRequirement :exec
DELETE FROM requirement_links WHERE organization_id = $1 AND requirement_id = $2;

-- name: DeletePendenciesOfRequirement :exec
DELETE FROM pendencies WHERE organization_id = $1 AND requirement_id = $2;

-- name: DetachBugsFromRequirement :exec
UPDATE bugs SET requirement_id = NULL, updated_at = now() WHERE organization_id = $1 AND requirement_id = $2;

-- name: DeleteRequirement :exec
DELETE FROM requirements WHERE organization_id = $1 AND id = $2;

-- name: DeleteLinksOfSpec :exec
DELETE FROM requirement_links l WHERE l.organization_id = $1 AND l.requirement_id IN (SELECT r.id FROM requirements r WHERE r.organization_id = $1 AND r.spec_id = $2);

-- name: DeletePendenciesOfSpec :exec
DELETE FROM pendencies p WHERE p.organization_id = $1 AND p.requirement_id IN (SELECT r.id FROM requirements r WHERE r.organization_id = $1 AND r.spec_id = $2);

-- name: DetachBugsFromSpec :exec
UPDATE bugs b SET requirement_id = NULL, updated_at = now() WHERE b.organization_id = $1 AND b.requirement_id IN (SELECT r.id FROM requirements r WHERE r.organization_id = $1 AND r.spec_id = $2);

-- name: DeleteRequirementsOfSpec :exec
DELETE FROM requirements WHERE organization_id = $1 AND spec_id = $2;

-- name: DeleteSpec :exec
DELETE FROM specs WHERE organization_id = $1 AND id = $2;

-- name: DeleteAgentLinksOfSpec :exec
DELETE FROM requirement_links l WHERE l.organization_id = $1 AND l.source = 'agent' AND l.requirement_id IN (SELECT r.id FROM requirements r WHERE r.organization_id = $1 AND r.spec_id = $2);
