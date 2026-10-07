-- name: BriefRequirements :many
-- Every requirement the project's specs have that applies to an environment (the written ones and the environment's own
-- automatic one), with the nodes of the given graph each is linked to.
SELECT s.id AS spec_id, s.title AS spec_title, s.source_type, r.key, r.text, r.criticality,
  COALESCE((SELECT array_agg(l.node_id) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE l.requirement_id = r.id AND n.graph_id = @graph_id), '{}')::uuid[] AS node_ids
FROM requirements r JOIN specs s ON s.id = r.spec_id
WHERE r.organization_id = @organization_id AND s.project_id = @project_id AND (s.source_type <> 'auto' OR s.environment_id = @environment_id)
ORDER BY s.version, r.key;

-- name: BriefOpenPendencies :one
SELECT count(*)::int FROM pendencies p
JOIN requirements r ON r.id = p.requirement_id
JOIN specs s ON s.id = r.spec_id
WHERE p.organization_id = @organization_id AND p.status = 'open' AND s.project_id = @project_id AND (s.source_type <> 'auto' OR s.environment_id = @environment_id);

-- name: BriefRecentRunners :one
SELECT count(*)::int FROM runners WHERE organization_id = $1 AND last_seen_at > now() - interval '2 minutes';
