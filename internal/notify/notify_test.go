package notify

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSendSignsAndFilters(t *testing.T) {
	var got []Payload
	var sigs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var p Payload
		json.Unmarshal(body, &p)
		got = append(got, p)
		sigs = append(sigs, r.Header.Get(SignatureHeader))
		if r.Header.Get("X-Team") != "shop" {
			t.Errorf("custom header missing")
		}
		if r.Header.Get(SignatureHeader) != Sign("s3cret", body) {
			t.Errorf("bad signature")
		}
	}))
	defer srv.Close()
	hooks := []Webhook{
		{URL: srv.URL, On: []string{"failure"}, Secret: "s3cret", Headers: map[string]string{"X-Team": "shop"}},
	}
	if errs := Send(context.Background(), hooks, Payload{Status: "success", App: "shop"}, nil); len(errs) != 0 || len(got) != 0 {
		t.Fatalf("a success must not reach a failure-only webhook: %v %v", errs, got)
	}
	if errs := Send(context.Background(), hooks, Payload{Status: "failure", App: "shop", Outcome: "rolled_back"}, nil); len(errs) != 0 {
		t.Fatal(errs)
	}
	if len(got) != 1 || got[0].Outcome != "rolled_back" {
		t.Fatalf("got %+v", got)
	}
}

func TestSendReportsFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	if errs := Send(context.Background(), []Webhook{{URL: srv.URL}}, Payload{Status: "success"}, nil); len(errs) != 1 {
		t.Fatalf("a 500 is a failed webhook: %v", errs)
	}
}
