package filter

import (
	"reflect"
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
)

// What the rules do is tested end to end (test/e2e, TestPortFilter and TestPortFilterIPv6): a
// port is reachable or not. Here, what Rules refuses, and which ports it treats as published.
func TestRulesRefuseInvalidPorts(t *testing.T) {
	for _, bad := range []Allow{
		{PublicPort: domain.PublicPort{Port: 70000}, Why: "app-x"},
		{PublicPort: domain.PublicPort{Port: 1, Protocol: "sctp"}, Why: "app-x"},
		{PublicPort: domain.PublicPort{Port: 1, From: []string{"nope"}}, Why: "app-x"},
	} {
		if _, err := Rules([]Allow{bad}, nil, 4); err == nil || !strings.Contains(err.Error(), "app-x") {
			t.Fatalf("%+v must be refused, naming its app: %v", bad, err)
		}
	}
}

// docker-proxy receives a port on the host for each family the port is bound on, except
// loopback: those are the ports DOCKFLOW-INPUT guards.
func TestHostPorts(t *testing.T) {
	published := []domain.Port{
		{HostPort: "5432", Protocol: "tcp"},                          // both families
		{HostPort: "5432", Protocol: "tcp"},                          // twice: once
		{HostIP: "127.0.0.1", HostPort: "6379", Protocol: "tcp"},     // loopback
		{HostIP: "::1", HostPort: "6380", Protocol: "tcp"},           // loopback
		{HostIP: "0.0.0.0", HostPort: "8080", Protocol: "tcp"},       // IPv4 only
		{HostIP: "::", HostPort: "8443", Protocol: "udp"},            // IPv6 only
		{HostIP: "2001:db8::1", HostPort: "9000-9002", Protocol: ""}, // a range, tcp
		{HostPort: "", Protocol: "tcp"},                              // random: IPv4Only binds it
		{HostPort: "nope", Protocol: "tcp"},
	}
	if got, want := hostPorts(published, 4), []hostPort{{"tcp", "5432"}, {"tcp", "8080"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("IPv4: %v, want %v", got, want)
	}
	if got, want := hostPorts(published, 6), []hostPort{{"tcp", "5432"}, {"udp", "8443"}, {"tcp", "9000:9002"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("IPv6: %v, want %v", got, want)
	}
}

func TestIPv4Only(t *testing.T) {
	in := []domain.Port{
		{ContainerPort: 80, Protocol: "tcp"},
		{HostPort: "8080", ContainerPort: 80, Protocol: "tcp"},
		{HostIP: "::", ContainerPort: 81, Protocol: "tcp"},
	}
	got := IPv4Only(in)
	if got[0].HostIP != "0.0.0.0" || got[1].HostIP != "" || got[2].HostIP != "::" {
		t.Fatalf("only a random port without host IP is bound to IPv4: %+v", got)
	}
	if in[0].HostIP != "" {
		t.Fatal("IPv4Only must not change its argument")
	}
}
