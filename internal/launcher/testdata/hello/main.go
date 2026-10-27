// Command hello resolves a name, which links the C library when cgo is on.
package main

import "net"

func main() { _, _ = net.LookupHost("localhost") }
