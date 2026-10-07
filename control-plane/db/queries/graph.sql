-- name: NextGraphVersion :one
SELECT (COALESCE(MAX(version), 0) + 1)::int FROM graphs WHERE organization_id = $1 AND environment_id = $2;

-- name: CreateGraph :one
INSERT INTO graphs (organization_id, project_id, environment_id, version, source_run_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: GetGraph :one
SELECT * FROM graphs WHERE organization_id = $1 AND id = $2;

-- name: GetLatestGraph :one
SELECT * FROM graphs WHERE organization_id = $1 AND environment_id = $2 ORDER BY version DESC LIMIT 1;

-- name: UpsertNode :one
INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (graph_id, fingerprint) DO UPDATE SET
    app_roles = ARRAY(SELECT DISTINCT unnest(nodes.app_roles || EXCLUDED.app_roles) ORDER BY 1),
    updated_at = now()
RETURNING *;

-- name: GetNodeByFingerprint :one
SELECT * FROM nodes WHERE organization_id = $1 AND graph_id = $2 AND fingerprint = $3;

-- name: ListNodes :many
SELECT * FROM nodes WHERE organization_id = $1 AND graph_id = $2 ORDER BY created_at, id;

-- name: UpsertEdge :one
INSERT INTO edges (organization_id, graph_id, from_node_id, to_node_id, key, action, app_roles)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (graph_id, from_node_id, to_node_id, key) DO UPDATE SET
    app_roles = ARRAY(SELECT DISTINCT unnest(edges.app_roles || EXCLUDED.app_roles) ORDER BY 1),
    updated_at = now()
RETURNING *;

-- name: ListEdges :many
SELECT * FROM edges WHERE organization_id = $1 AND graph_id = $2 ORDER BY created_at, id;

-- name: SetGraphSourceRun :exec
UPDATE graphs SET source_run_id = $3, updated_at = now() WHERE organization_id = $1 AND id = $2;

-- name: GetNodeByID :one
SELECT * FROM nodes WHERE organization_id = $1 AND id = $2;

-- name: UpsertEndpointNode :one
INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
VALUES ($1, $2, 'endpoint', $3, $4, '{api}', $5)
ON CONFLICT (graph_id, fingerprint) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata, updated_at = now()
RETURNING *;

-- name: DeleteAgentLinksOfEndpoints :exec
DELETE FROM requirement_links l
USING nodes n
WHERE l.node_id = n.id AND l.source = 'agent' AND n.organization_id = $1 AND n.graph_id = $2 AND n.kind = 'endpoint';

-- name: LinkEndpointRequirement :exec
INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source)
VALUES ($1, $2, $3, 1, 'agent')
ON CONFLICT (requirement_id, node_id) DO UPDATE SET confidence = 1, updated_at = now();

-- name: CopyEndpointNodes :exec
INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
SELECT src.organization_id, @to_graph::uuid, src.kind, src.fingerprint, src.label, src.app_roles, src.metadata
FROM nodes src WHERE src.organization_id = @org AND src.graph_id = @from_graph AND src.kind = 'endpoint'
ON CONFLICT (graph_id, fingerprint) DO NOTHING;

-- name: CopyEndpointLinks :exec
INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source)
SELECT l.organization_id, l.requirement_id, n2.id, l.confidence, l.source
FROM requirement_links l
JOIN nodes n1 ON n1.id = l.node_id AND n1.graph_id = @from_graph AND n1.kind = 'endpoint'
JOIN nodes n2 ON n2.graph_id = @to_graph AND n2.fingerprint = n1.fingerprint
WHERE l.organization_id = @org
ON CONFLICT (requirement_id, node_id) DO NOTHING;

-- name: ListEnvironmentGraphsLatest :many
SELECT DISTINCT ON (g.environment_id) g.* FROM graphs g
WHERE g.organization_id = $1 AND g.project_id = $2
ORDER BY g.environment_id, g.version DESC;

-- name: LatestNodeResults :many
-- What the last testing run said about each node of a graph. A screen keeps its verdict across graph versions: the
-- steps of any node of the environment with the same fingerprint count. Per node, only the newest run that tested it.
WITH mine AS (
    SELECT mn.id, mn.fingerprint FROM nodes mn WHERE mn.organization_id = $1 AND mn.graph_id = $3
),
steps AS (
    SELECT m.id AS node_id, s.run_id, s.result, s.created_at
    FROM mine m
    JOIN nodes n2 ON n2.organization_id = $1 AND n2.fingerprint = m.fingerprint
    JOIN graphs g2 ON g2.id = n2.graph_id AND g2.environment_id = $2
    JOIN run_steps s ON s.organization_id = $1 AND s.node_id = n2.id AND s.result IS NOT NULL AND s.security IS NULL
),
latest AS (
    SELECT DISTINCT ON (node_id) node_id, run_id FROM steps ORDER BY node_id, created_at DESC
)
SELECT l.node_id, l.run_id,
       (count(*) FILTER (WHERE s.result = 'pass'))::int AS passed,
       (count(*) FILTER (WHERE s.result = 'fail'))::int AS failed,
       (count(*) FILTER (WHERE s.result = 'error'))::int AS errored,
       (count(*) FILTER (WHERE s.result = 'skipped'))::int AS skipped,
       max(s.created_at)::timestamptz AS at
FROM latest l
JOIN steps s ON s.node_id = l.node_id AND s.run_id = l.run_id
GROUP BY l.node_id, l.run_id;

-- name: CountLinksByNode :many
-- Which requirements (of any spec) are linked to each node of a graph: what makes a node "covered" and by what.
SELECT l.node_id, count(*)::int AS requirements, (array_agg(r.key ORDER BY r.key))[1:8]::text[] AS keys
FROM requirement_links l
JOIN requirements r ON r.id = l.requirement_id
JOIN nodes n ON n.id = l.node_id AND n.organization_id = l.organization_id
WHERE l.organization_id = $1 AND n.graph_id = $2
GROUP BY l.node_id;

-- name: SetNodeThumbnail :exec
UPDATE nodes SET thumbnail_key = $3, thumbnail_content_type = $4, updated_at = now() WHERE organization_id = $1 AND id = $2;

-- name: CopyNodesOfOtherUsers :exec
-- Exploring some users must not wipe the map of the others: their screens (and pictures) come along to the new graph.
-- Endpoints are not here: every exploration carries those forward already (CopyEndpointNodes).
INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata, thumbnail_key, thumbnail_content_type)
SELECT src.organization_id, @to_graph::uuid, src.kind, src.fingerprint, src.label, src.app_roles, src.metadata, src.thumbnail_key, src.thumbnail_content_type
FROM nodes src
WHERE src.organization_id = @org AND src.graph_id = @from_graph AND src.kind <> 'endpoint' AND NOT (src.app_roles && @explored::text[])
  AND (cardinality(@keep::text[]) = 0 OR src.app_roles && @keep::text[])
ON CONFLICT (graph_id, fingerprint) DO NOTHING;

-- name: CopyEdgesOfOtherUsers :exec
INSERT INTO edges (organization_id, graph_id, from_node_id, to_node_id, key, action, app_roles)
SELECT e.organization_id, @to_graph::uuid, nf2.id, nt2.id, e.key, e.action, e.app_roles
FROM edges e
JOIN nodes nf ON nf.id = e.from_node_id
JOIN nodes nt ON nt.id = e.to_node_id
JOIN nodes nf2 ON nf2.graph_id = @to_graph AND nf2.fingerprint = nf.fingerprint
JOIN nodes nt2 ON nt2.graph_id = @to_graph AND nt2.fingerprint = nt.fingerprint
WHERE e.organization_id = @org AND e.graph_id = @from_graph AND NOT (e.app_roles && @explored::text[])
  AND (cardinality(@keep::text[]) = 0 OR e.app_roles && @keep::text[])
ON CONFLICT (graph_id, from_node_id, to_node_id, key) DO NOTHING;

-- name: CopyLinksOfOtherUsers :exec
INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source)
SELECT l.organization_id, l.requirement_id, n2.id, l.confidence, l.source
FROM requirement_links l
JOIN nodes n1 ON n1.id = l.node_id AND n1.graph_id = @from_graph AND n1.kind <> 'endpoint' AND NOT (n1.app_roles && @explored::text[])
  AND (cardinality(@keep::text[]) = 0 OR n1.app_roles && @keep::text[])
JOIN nodes n2 ON n2.graph_id = @to_graph AND n2.fingerprint = n1.fingerprint
WHERE l.organization_id = @org
ON CONFLICT (requirement_id, node_id) DO NOTHING;

-- name: ListResumeNodes :many
-- What a resumed exploration already knows: the examined screens of each user (and where their actions led).
SELECT n.fingerprint, n.app_roles, (n.metadata->'followed')::jsonb AS followed
FROM nodes n
WHERE n.organization_id = $1 AND n.graph_id = $2 AND n.kind = 'page'
ORDER BY n.created_at, n.id
LIMIT 5000;

-- name: GetPreviousGraph :one
-- The map this version replaced.
SELECT p.* FROM graphs p JOIN graphs g ON g.environment_id = p.environment_id AND g.organization_id = p.organization_id
WHERE g.organization_id = $1 AND g.id = $2 AND p.version < g.version ORDER BY p.version DESC LIMIT 1;

-- name: DeleteGraphLinks :exec
DELETE FROM requirement_links l USING nodes n WHERE l.node_id = n.id AND n.organization_id = $1 AND n.graph_id = $2;

-- name: DeleteGraphEdges :exec
DELETE FROM edges WHERE organization_id = $1 AND graph_id = $2;

-- name: DeleteGraphNodes :exec
DELETE FROM nodes WHERE organization_id = $1 AND graph_id = $2;

-- name: DeleteGraph :exec
DELETE FROM graphs WHERE organization_id = $1 AND id = $2;

-- name: CountStepsOfGraph :one
SELECT count(*)::int FROM run_steps s JOIN nodes n ON n.id = s.node_id WHERE n.organization_id = $1 AND n.graph_id = $2;
