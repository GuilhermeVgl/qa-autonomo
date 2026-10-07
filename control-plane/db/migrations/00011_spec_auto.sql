-- +goose Up
-- Specs geradas pela varredura do mapa (source_type = 'auto'): um requisito por tela, formulário e chamada observada.
ALTER TABLE specs DROP CONSTRAINT specs_source_type_check;
ALTER TABLE specs ADD CONSTRAINT specs_source_type_check CHECK (source_type IN ('text', 'document', 'openapi', 'auto'));

-- +goose Down
ALTER TABLE specs DROP CONSTRAINT specs_source_type_check;
ALTER TABLE specs ADD CONSTRAINT specs_source_type_check CHECK (source_type IN ('text', 'document', 'openapi'));
