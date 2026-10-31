package planner

import (
	"strings"
	"testing"

	"github.com/Shawiizz/dockflow/internal/domain"
)

func TestNetworkDrift(t *testing.T) {
	yes := true
	// as Docker reports a network created from a file that set a subnet and an option
	server := domain.Network{
		Name: "shop-production_back", Driver: "bridge", EnableIPv6: new(bool),
		DriverOpts: map[string]string{"com.docker.network.driver.mtu": "1400"},
		Labels:     map[string]string{"com.example.net": "back", domain.LabelProject: "shop-production"},
		IPAM:       &domain.IPAM{Driver: "default", Pools: []domain.IPAMPool{{Subnet: "172.30.5.0/24", Gateway: "172.30.5.1"}}},
	}
	same := domain.Network{
		Key: "back", Driver: "", DriverOpts: map[string]string{"com.docker.network.driver.mtu": "1400"},
		Labels: map[string]string{"com.example.net": "back"},
		IPAM:   &domain.IPAM{Pools: []domain.IPAMPool{{Subnet: "172.30.5.0/24"}}},
	}
	if d := networkDrift(same, server, nil); d != "" {
		t.Fatalf("what Docker adds is not a change: %s", d)
	}
	if d := networkDrift(domain.Network{Key: "back"}, server, nil); d != "" {
		t.Fatalf("a file that sets nothing contradicts nothing: %s", d)
	}

	for name, change := range map[string]func(n *domain.Network){
		"ipam.config": func(n *domain.Network) { n.IPAM = &domain.IPAM{Pools: []domain.IPAMPool{{Subnet: "172.31.0.0/24"}}} },
		"gateway": func(n *domain.Network) {
			n.IPAM = &domain.IPAM{Pools: []domain.IPAMPool{{Subnet: "172.30.5.0/24", Gateway: "172.30.5.254"}}}
		},
		"driver_opts": func(n *domain.Network) { n.DriverOpts = map[string]string{"com.docker.network.driver.mtu": "9000"} },
		"labels":      func(n *domain.Network) { n.Labels = map[string]string{"com.example.net": "front"} },
		"internal":    func(n *domain.Network) { n.Internal = true },
		"enable_ipv6": func(n *domain.Network) { n.EnableIPv6 = &yes },
		"driver":      func(n *domain.Network) { n.Driver = "macvlan" },
	} {
		n := same
		change(&n)
		if d := networkDrift(n, server, nil); !strings.Contains(d, name) {
			t.Errorf("a changed %s is not seen: %q", name, d)
		}
	}
}

func TestVolumeDrift(t *testing.T) {
	server := domain.Volume{Name: "shop-production_data", Driver: "local",
		DriverOpts: map[string]string{"type": "tmpfs", "device": "tmpfs"}, Labels: map[string]string{"k": "v", domain.LabelProject: "shop-production"}}
	if d := volumeDrift(domain.Volume{DriverOpts: map[string]string{"type": "tmpfs", "device": "tmpfs"}, Labels: map[string]string{"k": "v"}}, server, nil); d != "" {
		t.Fatalf("the same volume: %s", d)
	}
	if d := volumeDrift(domain.Volume{DriverOpts: map[string]string{"type": "tmpfs", "device": "tmpfs", "o": "size=1m"}}, server, nil); !strings.Contains(d, "driver_opts") {
		t.Fatalf("changed options are not seen: %q", d)
	}
	if d := volumeDrift(domain.Volume{}, domain.Volume{Driver: "local"}, nil); d != "" {
		t.Fatalf("a plain volume: %s", d)
	}
}

func TestRemovalDrift(t *testing.T) {
	server := domain.Network{Name: "n", Driver: "bridge",
		DriverOpts: map[string]string{"com.docker.network.driver.mtu": "1400"},
		Labels:     map[string]string{"team": "core"},
		IPAM:       &domain.IPAM{Pools: []domain.IPAMPool{{Subnet: "172.30.5.0/24", Gateway: "172.30.5.1"}}}}
	prev := domain.Network{Name: "n", DriverOpts: server.DriverOpts, Labels: server.Labels,
		IPAM: &domain.IPAM{Pools: []domain.IPAMPool{{Subnet: "172.30.5.0/24"}}}}
	d := networkDrift(domain.Network{Name: "n"}, server, &prev)
	for _, want := range []string{"driver_opts.com.docker.network.driver.mtu was removed", "labels.team was removed", "ipam.config was removed"} {
		if !strings.Contains(d, want) {
			t.Errorf("not seen: %s, in %q", want, d)
		}
	}
	if d := networkDrift(prev, server, &prev); d != "" {
		t.Fatalf("nothing removed: %s", d)
	}
	// a release that never declared them: what Docker set itself is no removal
	if d := networkDrift(domain.Network{Name: "n"}, server, &domain.Network{Name: "n"}); d != "" {
		t.Fatalf("nothing was declared, nothing was removed: %s", d)
	}
	vol := domain.Volume{Name: "v", Driver: "local", Labels: map[string]string{"team": "core"}}
	if d := volumeDrift(domain.Volume{Name: "v"}, vol, &domain.Volume{Name: "v", Labels: vol.Labels}); !strings.Contains(d, "labels.team was removed") {
		t.Fatalf("a removed volume label is not seen: %q", d)
	}
}
