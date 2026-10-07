// Package db embeds the goose migrations.
package db

import "embed"

//go:embed migrations/*.sql
var Migrations embed.FS
