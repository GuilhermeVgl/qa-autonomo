-- +goose Up
CREATE TABLE llm_usage (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    run_id          uuid, -- FK para runs entra com a fatia de execução
    task            text NOT NULL,
    provider        text NOT NULL,
    model           text NOT NULL,
    tokens_in       integer NOT NULL,
    tokens_out      integer NOT NULL,
    cost            numeric(12, 6) NOT NULL DEFAULT 0, -- preços por modelo ainda não configurados
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE llm_usage;
