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
