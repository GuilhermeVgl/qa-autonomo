-- +goose Up
CREATE TABLE requirement_links (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    requirement_id  uuid NOT NULL REFERENCES requirements (id),
    node_id         uuid NOT NULL REFERENCES nodes (id),
    confidence      numeric(3, 2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source          text NOT NULL CHECK (source IN ('agent', 'human')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requirement_id, node_id)
);

CREATE TABLE pendencies (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    run_id          uuid REFERENCES runs (id),
    requirement_id  uuid NOT NULL REFERENCES requirements (id),
    node_id         uuid REFERENCES nodes (id),
    question        text NOT NULL,
    answer          text,
    answered_by     uuid REFERENCES users (id),
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pendencies_by_requirement ON pendencies (organization_id, requirement_id, status);

CREATE TABLE knowledge_entries (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id      uuid NOT NULL REFERENCES projects (id),
    content         text NOT NULL,
    origin          text NOT NULL CHECK (origin IN ('pendency', 'false_positive', 'manual')),
    origin_id       uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE knowledge_entries;
DROP TABLE pendencies;
DROP TABLE requirement_links;
