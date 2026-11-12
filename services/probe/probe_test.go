package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const testNonce = "n_AAAAAAAAAAAAAAAAAAAAAA"

type fakeStore struct {
	mu       sync.Mutex
	nonces   map[string]error
	receipts []Receipt
}

func (f *fakeStore) CheckNonce(_ context.Context, n string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	err, ok := f.nonces[n]
	if !ok {
		return ErrUnknownNonce
	}
	return err
}

func (f *fakeStore) InsertReceipt(_ context.Context, r Receipt) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.receipts {
		if x.Nonce == r.Nonce && x.Slot == r.Slot {
			return ErrDuplicateSlot
		}
	}
	f.receipts = append(f.receipts, r)
	return nil
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func body(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	copy(b, []byte{0xFF, 0xD8, 0xFF, 0xE0})
	return b
}

func newTestServer(t *testing.T, store Store, cfg Config, asn *ASNTable) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(NewServer(cfg, store, asn, quietLog()).Routes())
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, method, url string, b []byte, hdr map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, bytes.NewReader(b))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp, m
}

func TestPutRecordsReceipt(t *testing.T) {
	st := &fakeStore{nonces: map[string]error{testNonce: nil}}
	asn, _ := ParseASNTable(strings.NewReader("127.0.0.0\t127.255.255.255\t29465\tNG\tMTN\n"))
	ts := newTestServer(t, st, Config{}, asn)

	resp, m := do(t, "PUT", ts.URL+"/v1/probe/"+testNonce+"/1", body(ExpectedBytes), map[string]string{"content-type": "image/jpeg"})
	if resp.StatusCode != 200 {
		t.Fatalf("status %d %v", resp.StatusCode, m)
	}
	if resp.Header.Get("cache-control") != "no-store" {
		t.Fatal("missing no-store")
	}
	if int(m["received_bytes"].(float64)) != ExpectedBytes {
		t.Fatalf("received_bytes %v", m)
	}
	if len(st.receipts) != 1 || st.receipts[0].Slot != 1 || st.receipts[0].Bytes != ExpectedBytes || st.receipts[0].ASN != 29465 {
		t.Fatalf("receipt %+v", st.receipts)
	}

	// Same nonce and slot again: conflict, first receipt wins.
	resp, m = do(t, "PUT", ts.URL+"/v1/probe/"+testNonce+"/1", body(10), nil)
	if resp.StatusCode != 409 || m["error"].(map[string]any)["code"] != "nonce_used" {
		t.Fatalf("duplicate: %d %v", resp.StatusCode, m)
	}
	// Another SIM slot on the same nonce is fine.
	if resp, _ = do(t, "PUT", ts.URL+"/v1/probe/"+testNonce+"/0", body(100), nil); resp.StatusCode != 200 {
		t.Fatalf("slot 0: %d", resp.StatusCode)
	}
}

func TestPutRejections(t *testing.T) {
	expired := "n_BBBBBBBBBBBBBBBBBBBBBB"
	st := &fakeStore{nonces: map[string]error{testNonce: nil, expired: ErrNonceExpired}}
	ts := newTestServer(t, st, Config{}, nil)

	cases := []struct {
		name, path string
		size       int
		status     int
		code       string
	}{
		{"unknown nonce", "/v1/probe/n_CCCCCCCCCCCCCCCCCCCCCC/0", 10, 404, "unknown_nonce"},
		{"expired nonce", "/v1/probe/" + expired + "/0", 10, 410, "nonce_expired"},
		{"bad nonce shape", "/v1/probe/hello/0", 10, 404, "not_found"},
		{"bad slot", "/v1/probe/" + testNonce + "/4", 10, 404, "not_found"},
		{"too large", "/v1/probe/" + testNonce + "/2", MaxBodyBytes + 1, 413, "invalid_body"},
	}
	for _, c := range cases {
		resp, m := do(t, "PUT", ts.URL+c.path, body(c.size), nil)
		if resp.StatusCode != c.status {
			t.Errorf("%s: status %d want %d", c.name, resp.StatusCode, c.status)
			continue
		}
		if got := m["error"].(map[string]any)["code"]; got != c.code {
			t.Errorf("%s: code %v want %s", c.name, got, c.code)
		}
	}
	if len(st.receipts) != 0 {
		t.Fatalf("rejected uploads left receipts: %+v", st.receipts)
	}
}

func TestHeadAndHealth(t *testing.T) {
	ts := newTestServer(t, &fakeStore{}, Config{}, nil)
	resp, _ := do(t, "HEAD", ts.URL+"/v1/probe/"+testNonce+"/0", nil, nil)
	if resp.StatusCode != 204 || resp.Header.Get("cache-control") != "no-store" {
		t.Fatalf("head: %d %q", resp.StatusCode, resp.Header.Get("cache-control"))
	}
	resp, m := do(t, "GET", ts.URL+"/healthz", nil, nil)
	if resp.StatusCode != 200 || m["ok"] != true {
		t.Fatalf("healthz: %d %v", resp.StatusCode, m)
	}
	// GET on the probe path is not a route.
	if resp, _ = do(t, "GET", ts.URL+"/v1/probe/"+testNonce+"/0", nil, nil); resp.StatusCode != 405 {
		t.Fatalf("GET probe: %d", resp.StatusCode)
	}
}

func TestClientIPWithProxyHops(t *testing.T) {
	st := &fakeStore{nonces: map[string]error{testNonce: nil}}
	ts := newTestServer(t, st, Config{TrustedProxyHops: 1}, nil)
	// The client forges a left entry; the ingress appends the real one.
	do(t, "PUT", ts.URL+"/v1/probe/"+testNonce+"/0", body(10),
		map[string]string{"X-Forwarded-For": "1.2.3.4, 102.89.1.7"})
	if got := st.receipts[0].ClientIP; got != netip.MustParseAddr("102.89.1.7") {
		t.Fatalf("client ip %v", got)
	}

	r := httptest.NewRequest("PUT", "/", nil)
	r.RemoteAddr = "[::ffff:10.0.0.9]:5555"
	if got := clientIP(r, 0); got != netip.MustParseAddr("10.0.0.9") {
		t.Fatalf("remote addr %v", got)
	}
	if got := clientIP(r, 1); got.IsValid() {
		t.Fatalf("no XFF with hops=1 should be unknown, got %v", got)
	}
}

func TestRateLimitAndCapacity(t *testing.T) {
	st := &fakeStore{nonces: map[string]error{testNonce: nil}}
	ts := newTestServer(t, st, Config{PerIPPerMinute: 2}, nil)
	for i, want := range []int{200, 200, 429} {
		resp, _ := do(t, "PUT", ts.URL+"/v1/probe/"+testNonce+"/"+string(rune('0'+i)), body(10), nil)
		if resp.StatusCode != want {
			t.Fatalf("request %d: %d want %d", i, resp.StatusCode, want)
		}
	}

	l := newIPLimiter(1, time.Minute)
	a := netip.MustParseAddr("1.1.1.1")
	t0 := time.Unix(0, 0)
	if !l.allow(a, t0) || l.allow(a, t0.Add(time.Second)) || !l.allow(a, t0.Add(61*time.Second)) {
		t.Fatal("fixed window wrong")
	}
}

func TestASNTable(t *testing.T) {
	tsv := "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET\n" +
		"102.88.0.0\t102.91.255.255\t29465\tNG\tVCG-AS\n" +
		"2.0.0.0\t2.0.0.255\t0\tNone\tNot routed\n"
	tb, err := ParseASNTable(strings.NewReader(tsv))
	if err != nil {
		t.Fatal(err)
	}
	for ip, want := range map[string]int{
		"102.89.1.7": 29465, "102.88.0.0": 29465, "102.91.255.255": 29465,
		"102.92.0.0": 0, "1.0.0.5": 13335, "2.0.0.1": 0, "0.0.0.1": 0, "2001:db8::1": 0,
	} {
		if got := tb.Lookup(netip.MustParseAddr(ip)); got != want {
			t.Errorf("%s: %d want %d", ip, got, want)
		}
	}
	if _, err := ParseASNTable(strings.NewReader("x\ty\tz\n")); err == nil {
		t.Fatal("malformed line accepted")
	}
	var nilTable *ASNTable
	if nilTable.Lookup(netip.MustParseAddr("1.0.0.5")) != 0 {
		t.Fatal("nil table lookup")
	}
}

// Integration test against a real database with the project's migrations:
//
//	PGDEV_PORT=54334 scripts/db-dev.sh start
//	PROBE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54334/pos_dev go test ./...
func TestPostgresStore(t *testing.T) {
	url := os.Getenv("PROBE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PROBE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := NewPGStore(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	pool, _ := pgxpool.New(ctx, url)
	defer pool.Close()

	var dev string
	if err := pool.QueryRow(ctx,
		`insert into devices (pubkey) values ('probe-test-' || gen_random_uuid()) returning id`).Scan(&dev); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `delete from devices where id = $1`, dev) })
	live := "n_" + strings.Repeat("L", 22)
	old := "n_" + strings.Repeat("O", 22)
	pool.Exec(ctx, `delete from nonces where nonce in ($1, $2)`, live, old)
	if _, err := pool.Exec(ctx, `insert into nonces (nonce, device_id) values ($1, $3), ($2, $3)`, live, old, dev); err != nil {
		t.Fatal(err)
	}
	pool.Exec(ctx, `update nonces set expires_at = now() - interval '1 second' where nonce = $1`, old)

	asn, _ := ParseASNTable(strings.NewReader("127.0.0.0\t127.255.255.255\t29465\tNG\tMTN\n"))
	ts := newTestServer(t, st, Config{}, asn)

	resp, m := do(t, "PUT", ts.URL+"/v1/probe/"+live+"/0", body(ExpectedBytes), nil)
	if resp.StatusCode != 200 {
		t.Fatalf("put: %d %v", resp.StatusCode, m)
	}
	var bytesGot int64
	var ip *string
	var asnGot *int
	if err := pool.QueryRow(ctx,
		`select bytes, host(client_ip), asn from probe_receipts where nonce = $1 and sim_slot = 0`, live).
		Scan(&bytesGot, &ip, &asnGot); err != nil {
		t.Fatal(err)
	}
	if bytesGot != ExpectedBytes || ip == nil || *ip != "127.0.0.1" || asnGot == nil || *asnGot != 29465 {
		t.Fatalf("row: %d %v %v", bytesGot, ip, asnGot)
	}
	if resp, _ = do(t, "PUT", ts.URL+"/v1/probe/"+live+"/0", body(10), nil); resp.StatusCode != 409 {
		t.Fatalf("duplicate: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "PUT", ts.URL+"/v1/probe/"+old+"/0", body(10), nil); resp.StatusCode != 410 {
		t.Fatalf("expired: %d", resp.StatusCode)
	}
	if resp, _ = do(t, "PUT", ts.URL+"/v1/probe/n_"+strings.Repeat("U", 22)+"/0", body(10), nil); resp.StatusCode != 404 {
		t.Fatalf("unknown: %d", resp.StatusCode)
	}
}
