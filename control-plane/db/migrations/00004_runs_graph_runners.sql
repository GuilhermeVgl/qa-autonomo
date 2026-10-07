-- +goose Up
CREATE TABLE runners (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    name            text NOT NULL,
    token_hash      text NOT NULL UNIQUE,
    labels          text[] NOT NULL DEFAULT '{}',
    last_seen_at    timestamptz,
    version         text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE graphs (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id      uuid NOT NULL REFERENCES projects (id),
    environment_id  uuid NOT NULL REFERENCES environments (id),
    version         integer NOT NULL,
    source_run_id   uuid, -- FK abaixo, depois de runs
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (environment_id, version)
);

CREATE TABLE runs (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    project_id       uuid NOT NULL REFERENCES projects (id),
    environment_id   uuid NOT NULL REFERENCES environments (id),
    graph_id         uuid REFERENCES graphs (id),
    type             text NOT NULL CHECK (type IN ('exploration', 'regression')),
    trigger          text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'ci')),
    status           text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    budget           jsonb NOT NULL DEFAULT '{}',
    runner_id        uuid REFERENCES runners (id),
    lease_expires_at timestamptz,
    attempts         integer NOT NULL DEFAULT 0,
    started_at       timestamptz,
    finished_at      timestamptz,
    summary          jsonb NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Lock por ambiente garantido pelo banco: no máximo um run ativo por ambiente.
CREATE UNIQUE INDEX runs_one_running_per_env ON runs (environment_id) WHERE status = 'running';
CREATE INDEX runs_queue ON runs (organization_id, status, created_at);

ALTER TABLE graphs ADD CONSTRAINT graphs_source_run_fk FOREIGN KEY (source_run_id) REFERENCES runs (id);

CREATE TABLE nodes (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    graph_id        uuid NOT NULL REFERENCES graphs (id),
    kind            text NOT NULL CHECK (kind IN ('page', 'modal', 'endpoint', 'command')),
    fingerprint     text NOT NULL,
    label           text NOT NULL,
    app_roles       text[] NOT NULL DEFAULT '{}',
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (graph_id, fingerprint)
);

CREATE TABLE edges (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    graph_id        uuid NOT NULL REFERENCES graphs (id),
    from_node_id    uuid NOT NULL REFERENCES nodes (id),
    to_node_id      uuid NOT NULL REFERENCES nodes (id),
    key             text NOT NULL, -- identidade estável da ação (ex.: "click a[href=/orders]"); desduplica reenvios
    action          jsonb NOT NULL,
    app_roles       text[] NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (graph_id, from_node_id, to_node_id, key)
);

-- Idempotência do lote de eventos do runner: (run, tentativa, seq).
CREATE TABLE run_events (
    run_id     uuid NOT NULL REFERENCES runs (id),
    attempt    integer NOT NULL,
    seq        bigint NOT NULL,
    type       text NOT NULL,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, attempt, seq)
);

-- +goose Down
DROP TABLE run_events;
DROP TABLE edges;
DROP TABLE nodes;
ALTER TABLE graphs DROP CONSTRAINT graphs_source_run_fk;
DROP TABLE runs;
DROP TABLE graphs;
DROP TABLE runners;
