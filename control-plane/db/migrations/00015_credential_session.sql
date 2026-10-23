-- +goose Up
-- Reuso de sessão (kind=session): guarda um storageState do Playwright (cookies + storage), cifrado como as demais
-- credenciais, para o runner entrar em apps atrás de qualquer login (SSO, 2FA, captcha) sem executar o login.
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('login', 'api_token', 'session'));

-- +goose Down
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('login', 'api_token'));
