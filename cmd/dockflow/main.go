// Command dockflow deploys Docker Compose apps to servers.
package main

import (
	"os"

	"github.com/Shawiizz/dockflow/internal/cli"
)

func main() {
	os.Exit(cli.Main(os.Args[1:]))
}
