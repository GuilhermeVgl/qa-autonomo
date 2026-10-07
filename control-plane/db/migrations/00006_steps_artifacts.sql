-- +goose Up
CREATE TABLE run_steps (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    run_id          uuid NOT NULL REFERENCES runs (id),
    client_key      text NOT NULL, -- chave do passo gerada pelo runner; step_started e step_finished se encontram nela
    node_id         uuid REFERENCES nodes (id),
    edge_id         uuid REFERENCES edges (id),
    executor        text NOT NULL CHECK (executor IN ('browser', 'mobile_web', 'api', 'terminal')),
    input_masked    jsonb NOT NULL DEFAULT '{}',
    expected        text NOT NULL DEFAULT '',
    actual          text NOT NULL DEFAULT '',
    result          text CHECK (result IN ('pass', 'fail', 'error', 'skipped')), -- nulo enquanto o passo roda
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, client_key)
);
CREATE INDEX run_steps_by_node ON run_steps (organization_id, node_id, created_at DESC);

CREATE TABLE artifacts (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    run_step_id     uuid NOT NULL REFERENCES run_steps (id),
    kind            text NOT NULL CHECK (kind IN ('screenshot', 'video', 'trace', 'har', 'console', 'http', 'stdout')),
    storage_key     text NOT NULL UNIQUE,
    content_type    text NOT NULL DEFAULT 'application/octet-stream',
    size            bigint NOT NULL CHECK (size >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_by_step ON artifacts (run_step_id);

-- +goose Down
DROP TABLE artifacts;
DROP TABLE run_steps;
