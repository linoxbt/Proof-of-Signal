package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
)

// asnRange is one IPv4 range from iptoasn.com's ip2asn-v4.tsv (public domain).
type asnRange struct {
	start, end uint32
	asn        int
}

// ASNTable maps IPv4 addresses to autonomous system numbers.
type ASNTable struct {
	ranges []asnRange
}

// LoadASNTable reads an ip2asn-v4.tsv file:
// range_start \t range_end \t AS_number \t country_code \t AS_description.
// Rows with AS number 0 ("Not routed") are skipped.
func LoadASNTable(path string) (*ASNTable, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseASNTable(f)
}

func ParseASNTable(r io.Reader) (*ASNTable, error) {
	t := &ASNTable{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	line := 0
	for sc.Scan() {
		line++
		fields := strings.Split(sc.Text(), "\t")
		if len(fields) < 3 {
			continue
		}
		start, err1 := parseIPv4(fields[0])
		end, err2 := parseIPv4(fields[1])
		asn, err3 := strconv.Atoi(fields[2])
		if err1 != nil || err2 != nil || err3 != nil {
			return nil, fmt.Errorf("ip2asn line %d: malformed", line)
		}
		if asn == 0 || end < start {
			continue
		}
		t.ranges = append(t.ranges, asnRange{start, end, asn})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	sort.Slice(t.ranges, func(i, j int) bool { return t.ranges[i].start < t.ranges[j].start })
	return t, nil
}

func parseIPv4(s string) (uint32, error) {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	if err != nil || !a.Is4() {
		return 0, fmt.Errorf("not an IPv4 address: %q", s)
	}
	b := a.As4()
	return binary.BigEndian.Uint32(b[:]), nil
}

// Lookup returns the ASN for addr, or 0 when unknown (IPv6, unrouted, no table).
func (t *ASNTable) Lookup(addr netip.Addr) int {
	if t == nil || !addr.Unmap().Is4() {
		return 0
	}
	b := addr.Unmap().As4()
	ip := binary.BigEndian.Uint32(b[:])
	i := sort.Search(len(t.ranges), func(i int) bool { return t.ranges[i].start > ip }) - 1
	if i >= 0 && ip <= t.ranges[i].end {
		return t.ranges[i].asn
	}
	return 0
}

func (t *ASNTable) Len() int {
	if t == nil {
		return 0
	}
	return len(t.ranges)
}
