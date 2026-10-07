-- +goose Up
ALTER TABLE runs ADD COLUMN target_node_ids uuid[]; -- regressão restrita (ex.: Reproduzir); nulo = todos os nós cobertos

CREATE TABLE bugs (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    project_id       uuid NOT NULL REFERENCES projects (id),
    fingerprint      text NOT NULL,
    title            text NOT NULL,
    status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'fixed', 'false_positive', 'reopened')),
    severity         text NOT NULL DEFAULT 'normal' CHECK (severity IN ('critical', 'high', 'normal')),
    requirement_id   uuid REFERENCES requirements (id),
    node_id          uuid REFERENCES nodes (id),
    node_fingerprint text NOT NULL DEFAULT '', -- estável entre versões do grafo; permite reproduzir em grafos novos
    first_seen_run_id uuid NOT NULL REFERENCES runs (id),
    last_seen_run_id  uuid NOT NULL REFERENCES runs (id),
    fixed_in_run_id   uuid REFERENCES runs (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, fingerprint)
);

CREATE TABLE bug_occurrences (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    bug_id          uuid NOT NULL REFERENCES bugs (id),
    run_id          uuid NOT NULL REFERENCES runs (id),
    run_step_id     uuid NOT NULL REFERENCES run_steps (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bug_id, run_step_id)
);
CREATE INDEX bug_occurrences_by_run ON bug_occurrences (run_id);

-- +goose Down
DROP TABLE bug_occurrences;
DROP TABLE bugs;
ALTER TABLE runs DROP COLUMN target_node_ids;
