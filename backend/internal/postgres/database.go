package postgres

import (
	"context"
	"database/sql"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Open keeps each service in its own schema when they share a connection URL.
func Open(dsn, schema string) (*sql.DB, error) {
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if schema != "" {
		config.RuntimeParams["search_path"] = pgx.Identifier{schema}.Sanitize()
	}
	return stdlib.OpenDB(*config), nil
}

func EnsureSchema(ctx context.Context, tx *sql.Tx, schema string) error {
	if schema == "" {
		return nil
	}
	_, err := tx.ExecContext(ctx, "CREATE SCHEMA IF NOT EXISTS "+pgx.Identifier{schema}.Sanitize())
	return err
}
