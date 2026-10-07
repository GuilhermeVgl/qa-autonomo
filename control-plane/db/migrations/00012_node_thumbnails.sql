-- +goose Up
-- Miniatura da tela de cada nó de página, tirada na exploração (campos de entrada cobertos). Fica no object storage;
-- aqui só a chave. Alimenta o módulo de Fluxos.
ALTER TABLE nodes ADD COLUMN thumbnail_key text;
ALTER TABLE nodes ADD COLUMN thumbnail_content_type text;

-- +goose Down
ALTER TABLE nodes DROP COLUMN thumbnail_content_type;
ALTER TABLE nodes DROP COLUMN thumbnail_key;
