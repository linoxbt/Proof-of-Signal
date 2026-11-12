package main

import (
	"context"
	"errors"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUnknownNonce  = errors.New("unknown nonce")
	ErrNonceExpired  = errors.New("nonce expired")
	ErrDuplicateSlot = errors.New("receipt already recorded")
)

// Receipt is one probe_receipts row.
type Receipt struct {
	Nonce      string
	Slot       int
	ReceivedAt time.Time
	Bytes      int64
	DurationMS int64
	ClientIP   netip.Addr // invalid = unknown
	ASN        int        // 0 = unknown
}

// Store is what the handler needs from the database.
type Store interface {
	// CheckNonce returns nil when the nonce exists and has not expired.
	CheckNonce(ctx context.Context, nonce string) error
	InsertReceipt(ctx context.Context, r Receipt) error
}

type pgStore struct{ pool *pgxpool.Pool }

func NewPGStore(ctx context.Context, url string) (*pgStore, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &pgStore{pool: pool}, nil
}

func (s *pgStore) Close() { s.pool.Close() }

func (s *pgStore) CheckNonce(ctx context.Context, nonce string) error {
	var expired bool
	err := s.pool.QueryRow(ctx,
		`select expires_at <= now() from public.nonces where nonce = $1`, nonce).Scan(&expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnknownNonce
	}
	if err != nil {
		return err
	}
	if expired {
		return ErrNonceExpired
	}
	return nil
}

func (s *pgStore) InsertReceipt(ctx context.Context, r Receipt) error {
	var ip any
	if r.ClientIP.IsValid() {
		ip = r.ClientIP.Unmap().String()
	}
	var asn any
	if r.ASN != 0 {
		asn = r.ASN
	}
	_, err := s.pool.Exec(ctx,
		`insert into public.probe_receipts (nonce, sim_slot, received_at, bytes, duration_ms, client_ip, asn)
		 values ($1, $2, $3, $4, $5, $6::inet, $7)`,
		r.Nonce, r.Slot, r.ReceivedAt, r.Bytes, r.DurationMS, ip, asn)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return ErrDuplicateSlot
		case "23503": // foreign_key_violation: nonce purged between check and insert
			return ErrUnknownNonce
		}
	}
	return err
}
