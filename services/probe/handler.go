package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ExpectedBytes = 1_572_864 // the test body the app sends per SIM
	MaxBodyBytes  = 2 << 20   // 2 MiB
)

var noncePattern = regexp.MustCompile(`^n_[A-Za-z0-9_-]{22}$`)

type Config struct {
	// TrustedProxyHops: how many reverse proxies in front of the probe append
	// to X-Forwarded-For (Azure Container Apps ingress = 1). 0 = use the
	// TCP peer address. The probe must never sit behind a CDN.
	TrustedProxyHops int
	MaxConcurrent    int           // simultaneous uploads; more get 503
	PerIPPerMinute   int           // PUTs per client IP per minute (mobile CGNAT: keep generous)
	BodyTimeout      time.Duration // whole-body read deadline
}

type Server struct {
	cfg     Config
	store   Store
	asn     *ASNTable
	log     *slog.Logger
	slots   chan struct{}
	limiter *ipLimiter
	now     func() time.Time
}

func NewServer(cfg Config, store Store, asn *ASNTable, log *slog.Logger) *Server {
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 200
	}
	if cfg.PerIPPerMinute <= 0 {
		cfg.PerIPPerMinute = 120
	}
	if cfg.BodyTimeout <= 0 {
		cfg.BodyTimeout = 150 * time.Second
	}
	return &Server{
		cfg:     cfg,
		store:   store,
		asn:     asn,
		log:     log,
		slots:   make(chan struct{}, cfg.MaxConcurrent),
		limiter: newIPLimiter(cfg.PerIPPerMinute, time.Minute),
		now:     time.Now,
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "asn_ranges": s.asn.Len()})
	})
	mux.HandleFunc("HEAD /v1/probe/{nonce}/{slot}", s.head)
	mux.HandleFunc("PUT /v1/probe/{nonce}/{slot}", s.put)
	return mux
}

func (s *Server) head(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if _, _, ok := parsePath(r); !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) put(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	noStore(w)

	nonce, slot, ok := parsePath(r)
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "unknown probe path")
		return
	}
	if r.ContentLength > MaxBodyBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "invalid_body", "body over 2 MiB")
		return
	}
	ip := clientIP(r, s.cfg.TrustedProxyHops)
	if !s.limiter.allow(ip, start) {
		w.Header().Set("retry-after", "60")
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many uploads from this address")
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		w.Header().Set("retry-after", "15")
		writeErr(w, http.StatusServiceUnavailable, "rate_limited", "probe at capacity")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	err := s.store.CheckNonce(ctx, nonce)
	cancel()
	switch {
	case errors.Is(err, ErrUnknownNonce):
		writeErr(w, http.StatusNotFound, "unknown_nonce", "nonce not issued")
		return
	case errors.Is(err, ErrNonceExpired):
		writeErr(w, http.StatusGone, "nonce_expired", "nonce expired")
		return
	case err != nil:
		s.log.Error("check nonce", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "database unavailable")
		return
	}

	// Read and discard the body. Timing runs from the handler start (headers
	// received) to the last body byte.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(start.Add(s.cfg.BodyTimeout))
	n, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	end := s.now()
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeErr(w, http.StatusRequestEntityTooLarge, "invalid_body", "body over 2 MiB")
			return
		}
		// Client gave up or the radio dropped: no receipt, so ingest will
		// not accept a pass for this SIM.
		s.log.Info("upload incomplete", "nonce", nonce, "slot", slot, "bytes", n, "err", err)
		return
	}

	rec := Receipt{
		Nonce:      nonce,
		Slot:       slot,
		ReceivedAt: end,
		Bytes:      n,
		DurationMS: end.Sub(start).Milliseconds(),
		ClientIP:   ip,
		ASN:        s.asn.Lookup(ip),
	}
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch err := s.store.InsertReceipt(ctx, rec); {
	case errors.Is(err, ErrDuplicateSlot):
		writeErr(w, http.StatusConflict, "nonce_used", "upload already recorded for this SIM")
		return
	case errors.Is(err, ErrUnknownNonce):
		writeErr(w, http.StatusNotFound, "unknown_nonce", "nonce not issued")
		return
	case err != nil:
		s.log.Error("insert receipt", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "could not record upload")
		return
	}
	s.log.Info("receipt", "slot", slot, "bytes", n, "ms", rec.DurationMS, "asn", rec.ASN)
	writeJSON(w, http.StatusOK, map[string]any{"received_bytes": n, "server_ms": rec.DurationMS})
}

func parsePath(r *http.Request) (string, int, bool) {
	nonce := r.PathValue("nonce")
	slot, err := strconv.Atoi(r.PathValue("slot"))
	if !noncePattern.MatchString(nonce) || err != nil || slot < 0 || slot > 3 {
		return "", 0, false
	}
	return nonce, slot, true
}

// clientIP returns the address of the phone. With hops > 0 it takes the entry
// that the outermost trusted proxy appended to X-Forwarded-For; anything to
// its left was supplied by the client and is ignored.
func clientIP(r *http.Request, hops int) netip.Addr {
	if hops > 0 {
		var parts []string
		for _, h := range r.Header.Values("X-Forwarded-For") {
			for _, p := range strings.Split(h, ",") {
				if p = strings.TrimSpace(p); p != "" {
					parts = append(parts, p)
				}
			}
		}
		if i := len(parts) - hops; i >= 0 && i < len(parts) {
			if a, err := netip.ParseAddr(parts[i]); err == nil {
				return a.Unmap()
			}
		}
		return netip.Addr{}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("cache-control", "no-store")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// ipLimiter is a fixed-window counter per client address.
type ipLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	counts map[netip.Addr]*ipWindow
}

type ipWindow struct {
	start time.Time
	n     int
}

func newIPLimiter(limit int, window time.Duration) *ipLimiter {
	return &ipLimiter{limit: limit, window: window, counts: map[netip.Addr]*ipWindow{}}
}

func (l *ipLimiter) allow(ip netip.Addr, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.counts) > 100_000 { // bound memory under a flood
		for k, v := range l.counts {
			if now.Sub(v.start) >= l.window {
				delete(l.counts, k)
			}
		}
	}
	w := l.counts[ip]
	if w == nil || now.Sub(w.start) >= l.window {
		l.counts[ip] = &ipWindow{start: now, n: 1}
		return true
	}
	w.n++
	return w.n <= l.limit
}
