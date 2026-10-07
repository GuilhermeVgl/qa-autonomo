-- +goose Up
-- A varredura automática descreve o mapa de UM ambiente (cada ambiente tem o seu); as specs escritas por pessoas seguem do projeto.
ALTER TABLE specs ADD COLUMN environment_id uuid REFERENCES environments (id);
-- as varreduras que já existiam eram de um ambiente só: o das telas a que seus requisitos estão ligados
UPDATE specs s SET environment_id = sub.environment_id
FROM (
    SELECT DISTINCT ON (r.spec_id) r.spec_id, g.environment_id
    FROM requirements r
    JOIN requirement_links l ON l.requirement_id = r.id
    JOIN nodes n ON n.id = l.node_id
    JOIN graphs g ON g.id = n.graph_id
    ORDER BY r.spec_id, g.version DESC
) sub
WHERE s.id = sub.spec_id AND s.source_type = 'auto';
CREATE INDEX specs_by_environment ON specs (environment_id) WHERE environment_id IS NOT NULL;

-- +goose Down
DROP INDEX specs_by_environment;
ALTER TABLE specs DROP COLUMN environment_id;
