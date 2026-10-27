//go:build e2e

package e2e

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestNginxVhosts checks the vhosts the nginx plugin writes, as its golden files hold them,
// with a real nginx -t: all of them in one nginx, as several apps share a server's nginx.
func TestNginxVhosts(t *testing.T) {
	files, err := filepath.Glob("../../internal/plugin/testdata/nginx-*.conf")
	if err != nil || len(files) < 3 {
		t.Fatalf("the nginx plugin's golden vhosts: %v %v", files, err)
	}
	cert, key := selfSigned(t, "api.example.com")
	var script strings.Builder
	write := func(path string, data []byte) {
		fmt.Fprintf(&script, "mkdir -p %s && echo %s | base64 -d > %s\n", filepath.Dir(path), base64.StdEncoding.EncodeToString(data), path)
	}
	script.WriteString("rm -rf /tmp/e2e-vhosts /tmp/e2e-le\n")
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		write("/tmp/e2e-vhosts/"+filepath.Base(f), b)
	}
	write("/tmp/e2e-le/api.example.com/fullchain.pem", cert)
	write("/tmp/e2e-le/api.example.com/privkey.pem", key)
	// this server's kernel may have no IPv6, which a real server's has
	script.WriteString("[ -e /proc/net/if_inet6 ] || sed -i '/listen \\[::\\]/d' /tmp/e2e-vhosts/*.conf\n")
	script.WriteString("docker run --rm -v /tmp/e2e-vhosts:/etc/nginx/conf.d:ro -v /tmp/e2e-le:/etc/letsencrypt/live:ro --entrypoint nginx " + nginxImage + " -t 2>&1")
	out, err := inServer(script.String())
	if err != nil || !strings.Contains(out, "test is successful") {
		t.Fatalf("nginx -t refuses the plugin's vhosts: %v\n%s", err, out)
	}
}

func selfSigned(t *testing.T, domain string) (certPEM, keyPEM []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: domain}, DNSNames: []string{domain},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	k, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: k})
}
