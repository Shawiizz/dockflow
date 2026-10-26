package launcher

import (
	"crypto/rand"
	"time"
)

const crockford = "0123456789abcdefghjkmnpqrstvwxyz"

// NewRunID returns a ULID in lower case: sortable by time, unique.
func NewRunID(now time.Time) string {
	var b [16]byte
	ms := uint64(now.UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	rand.Read(b[6:])
	// 128 bits as 26 base32 characters, the first holding 3 bits
	out := make([]byte, 26)
	var acc uint64
	bits := 0
	idx := 25
	for i := 15; i >= 0; i-- {
		acc |= uint64(b[i]) << bits
		bits += 8
		for bits >= 5 && idx >= 0 {
			out[idx] = crockford[acc&31]
			acc >>= 5
			bits -= 5
			idx--
		}
	}
	if idx >= 0 {
		out[idx] = crockford[acc&31]
	}
	return string(out)
}
