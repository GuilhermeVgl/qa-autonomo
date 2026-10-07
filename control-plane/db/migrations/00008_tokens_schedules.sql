-- +goose Up
CREATE TABLE api_tokens (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id      uuid NOT NULL REFERENCES projects (id),
    name            text NOT NULL,
    token_hash      text NOT NULL UNIQUE,
    scopes          text[] NOT NULL DEFAULT '{}',
    last_used_at    timestamptz,
    created_by      uuid REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id      uuid NOT NULL REFERENCES projects (id),
    environment_id  uuid NOT NULL REFERENCES environments (id),
    run_type        text NOT NULL CHECK (run_type IN ('exploration', 'regression')),
    cron            text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    next_run_at     timestamptz NOT NULL,
    last_run_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;

-- +goose Down
DROP TABLE schedules;
DROP TABLE api_tokens;
