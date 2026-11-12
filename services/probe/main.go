// Command probe is the Proof of Signal upload probe (contracts/api.md, "Probe").
// It receives each phone's 1.5 MB test upload over cellular, discards it, and
// records a receipt with timing and the client's ASN.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("probe stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	store, err := NewPGStore(ctx, dbURL)
	if err != nil {
		return err
	}
	defer store.Close()

	var asn *ASNTable
	if path := os.Getenv("IP2ASN_TSV"); path != "" {
		if asn, err = LoadASNTable(path); err != nil {
			return err
		}
		log.Info("ip2asn loaded", "ranges", asn.Len())
	} else {
		log.Warn("IP2ASN_TSV not set: receipts will have no ASN, so the mobile-network check is skipped")
	}

	cfg := Config{
		TrustedProxyHops: envInt("TRUSTED_PROXY_HOPS", 0),
		MaxConcurrent:    envInt("MAX_CONCURRENT_UPLOADS", 200),
		PerIPPerMinute:   envInt("PER_IP_PER_MINUTE", 120),
		BodyTimeout:      time.Duration(envInt("BODY_TIMEOUT_S", 150)) * time.Second,
	}
	srv := &http.Server{
		Addr:              ":" + envStr("PORT", "8080"),
		Handler:           NewServer(cfg, store, asn, log).Routes(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("probe listening", "addr", srv.Addr, "proxy_hops", cfg.TrustedProxyHops)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}
