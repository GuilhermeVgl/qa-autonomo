-- +goose Up
-- Ambiente de terminal: o CLI testado roda no próprio container efêmero do runner (CLAUDE.md, seção 12).
ALTER TABLE environments ADD COLUMN kind text NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'terminal'));
ALTER TABLE environments ADD COLUMN terminal_binary text;
ALTER TABLE environments ADD COLUMN terminal_image text;
-- Labels que o runner precisa ter para pegar o run (ex.: terminal, image:registry/cli:1).
ALTER TABLE runs ADD COLUMN required_labels text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE runs DROP COLUMN required_labels;
ALTER TABLE environments DROP COLUMN terminal_image;
ALTER TABLE environments DROP COLUMN terminal_binary;
ALTER TABLE environments DROP COLUMN kind;
