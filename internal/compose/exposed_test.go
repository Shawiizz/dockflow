package compose

import (
	"slices"
	"testing"
)

func TestExposed(t *testing.T) {
	for in, want := range map[string][]string{
		"8080":          {"8080"},
		"53/udp":        {"53/udp"},
		"9000-9002/udp": {"9000/udp", "9001/udp", "9002/udp"},
		"7000-7001":     {"7000", "7001"},
	} {
		got, err := exposed(in)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("exposed(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"http", "0", "70000", "9001-9000", "80/icmp", "80-"} {
		if _, err := exposed(bad); err == nil {
			t.Errorf("exposed(%q) is accepted", bad)
		}
	}
}
