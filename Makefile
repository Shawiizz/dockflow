VERSION ?= dev
LDFLAGS := -s -w -X github.com/Shawiizz/dockflow/internal/version.Version=$(VERSION)
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

.PHONY: build test contract e2e real lint fmt snapshot clean

# A static binary: it also runs as the agent, in an image holding nothing else.
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dockflow ./cmd/dockflow

test:
	go test ./...

# Contract tests fail instead of skipping when Docker is missing.
contract:
	DOCKFLOW_CONTRACT=1 go test -count=1 ./internal/engine/...

e2e:
	go test -tags e2e -count=1 -v -timeout 20m ./test/e2e/

# Fresh DigitalOcean droplets (ADR-0019): needs DIGITALOCEAN_TOKEN, costs a few cents a run.
real:
	go test -tags real -count=1 -v -timeout 60m ./test/real/

lint:
	test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	golangci-lint run --build-tags e2e,real ./...

fmt:
	gofmt -w .

# The agents first: every CLI is built with their checksums, and checks the agent it downloads
# against them (ADR-0020).
snapshot:
	rm -rf dist && mkdir -p dist
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o dist/dockflow-agent-linux-$$arch ./cmd/dockflow || exit 1; \
	done
	agents="amd64=$$(sha256sum dist/dockflow-agent-linux-amd64 | cut -d' ' -f1),arm64=$$(sha256sum dist/dockflow-agent-linux-arm64 | cut -d' ' -f1)"; \
	for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; [ $$os = windows ] && ext=.exe; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath \
			-ldflags "$(LDFLAGS) -X github.com/Shawiizz/dockflow/internal/version.Agents=$$agents" \
			-o dist/dockflow-$$os-$$arch$$ext ./cmd/dockflow || exit 1; \
	done
	cd dist && sha256sum * > SHA256SUMS

clean:
	rm -rf dist dockflow
