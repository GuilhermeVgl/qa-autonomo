-- +goose Up
-- Ambiente "mobile web": quando preenchido, o runner emula esse dispositivo (executor mobile_web).
ALTER TABLE environments ADD COLUMN device text;

-- +goose Down
ALTER TABLE environments DROP COLUMN device;
