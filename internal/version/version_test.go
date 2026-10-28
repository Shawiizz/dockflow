package version

import "testing"

func TestAgentSum(t *testing.T) {
	defer func(a string) { Agents = a }(Agents)
	Agents = "amd64=aa,arm64=bb"
	if AgentSum("amd64") != "aa" || AgentSum("arm64") != "bb" || AgentSum("riscv64") != "" {
		t.Fatal(AgentSum("amd64"), AgentSum("arm64"))
	}
	Agents = ""
	if AgentSum("amd64") != "" {
		t.Fatal("a build without checksums has none")
	}
}

func TestAtLeast(t *testing.T) {
	cases := []struct {
		v, min    string
		ok, known bool
	}{
		{"1.3.0", "1.2", true, true},
		{"1.2.0", "1.2", true, true},
		{"1.1.9", "1.2", false, true},
		{"2.0.0", "1.10.0", true, true},
		{"1.0.0-alpha.3", "1.0.0", false, true},
		{"1.0.0-alpha.10", "1.0.0-alpha.3", true, true},
		{"1.0.0-alpha.3", "1.0.0-alpha.10", false, true},
		{"1.0.0", "1.0.0-alpha.3", true, true},
		{"1.0.0-beta", "1.0.0-alpha.3", true, true},
		{"dev", "1.0", false, false},
		{"snapshot-abc", "1.0", false, false},
	}
	for _, c := range cases {
		if ok, known := AtLeast(c.v, c.min); ok != c.ok || known != c.known {
			t.Errorf("AtLeast(%s, %s) = %v, %v", c.v, c.min, ok, known)
		}
	}
	for _, bad := range []string{"1", "v1.2", ">=1.2", "1.2.3.4", "01.2", "1.x"} {
		if Valid(bad) {
			t.Errorf("%q is not a version", bad)
		}
	}
}
