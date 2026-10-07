-- +goose Up
CREATE TABLE organizations (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    name       text NOT NULL,
    slug       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    email           text NOT NULL,
    oidc_subject    text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, oidc_subject)
);

CREATE TABLE memberships (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    user_id         uuid NOT NULL REFERENCES users (id),
    role            text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);

CREATE TABLE audit_log (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    actor           text NOT NULL,
    action          text NOT NULL,
    target          text NOT NULL DEFAULT '',
    payload         jsonb NOT NULL DEFAULT '{}',
    at              timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE audit_log;
DROP TABLE memberships;
DROP TABLE users;
DROP TABLE organizations;
