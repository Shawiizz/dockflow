VERSION ?= dev
LDFLAGS := -s -w -X github.com/Shawiizz/dockflow/internal/version.Version=$(VERSION)
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

.PHONY: build test contract e2e lint fmt snapshot clean

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

lint:
	test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	golangci-lint run --build-tags e2e ./...

fmt:
	gofmt -w .

snapshot:
	rm -rf dist && mkdir -p dist
	for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; [ $$os = windows ] && ext=.exe; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o dist/dockflow-$$os-$$arch$$ext ./cmd/dockflow || exit 1; \
	done
	cd dist && sha256sum * > SHA256SUMS

clean:
	rm -rf dist dockflow
