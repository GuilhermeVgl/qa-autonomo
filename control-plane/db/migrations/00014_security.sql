-- +goose Up
-- Verificações de segurança fazem parte da exploração e da regressão: cada achado é um passo (com o check, a severidade e o
-- escopo) e vira um bug de categoria "security", separado dos bugs funcionais.
ALTER TABLE run_steps ADD COLUMN security jsonb; -- {check, severity, scope}; nulo = passo funcional
ALTER TABLE bugs ADD COLUMN category text NOT NULL DEFAULT 'functional' CHECK (category IN ('functional', 'security'));
ALTER TABLE bugs ADD COLUMN security_check text;

-- +goose Down
ALTER TABLE bugs DROP COLUMN security_check;
ALTER TABLE bugs DROP COLUMN category;
ALTER TABLE run_steps DROP COLUMN security;
