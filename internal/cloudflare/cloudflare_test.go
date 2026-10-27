package cloudflare

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	got, err := Parse("173.245.48.0/20\n103.21.244.0/22\n\n", false)
	if err != nil || strings.Join(got, ",") != "173.245.48.0/20,103.21.244.0/22" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, bad := range []string{"", "<html>blocked</html>", "2400:cb00::/32", "10.0.0.0/8\n0.0.0.0/0", "1.2.3.4"} {
		if _, err := Parse(bad, false); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if _, err := Parse("2400:cb00::/32\n", true); err != nil {
		t.Fatal(err)
	}
}

func TestDefaultIsValid(t *testing.T) {
	var v4, v6 []string
	for _, r := range Default {
		if strings.Contains(r, ":") {
			v6 = append(v6, r)
		} else {
			v4 = append(v4, r)
		}
	}
	if _, err := Parse(strings.Join(v4, "\n"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(strings.Join(v6, "\n"), true); err != nil {
		t.Fatal(err)
	}
}

func TestFetchRefusesAnErrorPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	client := srv.Client()
	client.Transport = rewrite{srv.URL}
	if _, err := Fetch(context.Background(), client); err == nil {
		t.Fatal("a failed download must be an error")
	}
}

// rewrite sends every request to a test server.
type rewrite struct{ base string }

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	u := *req.URL
	target, _ := http.NewRequest(req.Method, r.base+u.Path, nil)
	return http.DefaultTransport.RoundTrip(target)
}
