-- +goose Up
CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id    uuid NOT NULL REFERENCES organizations (id),
    project_id         uuid NOT NULL REFERENCES projects (id),
    name               text NOT NULL,
    base_url           text NOT NULL,
    allowed_hosts      text[] NOT NULL,
    destructive_policy text NOT NULL DEFAULT 'block' CHECK (destructive_policy IN ('block', 'confirm', 'allow')),
    is_production      boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE credentials (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id   uuid NOT NULL REFERENCES organizations (id),
    environment_id    uuid NOT NULL REFERENCES environments (id),
    app_role          text NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('login', 'api_token')),
    payload_encrypted bytea NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (environment_id, app_role, kind)
);

CREATE TABLE specs (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    project_id      uuid NOT NULL REFERENCES projects (id),
    version         integer NOT NULL,
    source_type     text NOT NULL CHECK (source_type IN ('text', 'document', 'openapi')),
    title           text NOT NULL,
    raw_storage_key text, -- preenchido quando o object storage entrar (documentos/OpenAPI)
    extracted_text  text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);

CREATE TABLE requirements (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    spec_id         uuid NOT NULL REFERENCES specs (id),
    key             text NOT NULL,
    text            text NOT NULL,
    criticality     text NOT NULL CHECK (criticality IN ('critical', 'high', 'normal')),
    -- relativo à versão anterior da spec: marca o que precisa ser retestado
    status          text NOT NULL CHECK (status IN ('new', 'changed', 'unchanged')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (spec_id, key)
);

-- +goose Down
DROP TABLE requirements;
DROP TABLE specs;
DROP TABLE credentials;
DROP TABLE environments;
DROP TABLE projects;
