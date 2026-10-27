// Command volplugin is a minimal Docker volume plugin for the e2e tests: each volume is a
// directory of its propagated mount, created with a file holding the GREETING setting.
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const root = "/data"

type request struct {
	Name string
}

type volume struct {
	Name       string
	Mountpoint string
}

func main() {
	if err := os.MkdirAll("/run/docker/plugins", 0o755); err != nil {
		log.Fatal(err)
	}
	l, err := net.Listen("unix", "/run/docker/plugins/vol.sock")
	if err != nil {
		log.Fatal(err)
	}
	var mu sync.Mutex
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/vnd.docker.plugins.v1+json")
		json.NewEncoder(w).Encode(v)
	}
	read := func(r *http.Request) request {
		var q request
		json.NewDecoder(r.Body).Decode(&q)
		return q
	}
	path := func(name string) string { return filepath.Join(root, filepath.Base(name)) }
	mux := http.NewServeMux()
	mux.HandleFunc("/Plugin.Activate", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"Implements": []string{"VolumeDriver"}})
	})
	mux.HandleFunc("/VolumeDriver.Capabilities", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"Capabilities": map[string]string{"Scope": "local"}})
	})
	mux.HandleFunc("/VolumeDriver.Create", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		p := path(read(r).Name)
		err := os.MkdirAll(p, 0o755)
		if err == nil {
			err = os.WriteFile(filepath.Join(p, "greeting"), []byte(os.Getenv("GREETING")), 0o644)
		}
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		reply(w, map[string]string{"Err": msg})
	})
	mux.HandleFunc("/VolumeDriver.Remove", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		os.RemoveAll(path(read(r).Name))
		reply(w, map[string]string{"Err": ""})
	})
	for _, ep := range []string{"/VolumeDriver.Mount", "/VolumeDriver.Path"} {
		mux.HandleFunc(ep, func(w http.ResponseWriter, r *http.Request) {
			reply(w, map[string]string{"Mountpoint": path(read(r).Name), "Err": ""})
		})
	}
	mux.HandleFunc("/VolumeDriver.Unmount", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]string{"Err": ""})
	})
	mux.HandleFunc("/VolumeDriver.Get", func(w http.ResponseWriter, r *http.Request) {
		name := read(r).Name
		if _, err := os.Stat(path(name)); err != nil {
			reply(w, map[string]string{"Err": "no such volume"})
			return
		}
		reply(w, map[string]any{"Volume": volume{name, path(name)}, "Err": ""})
	})
	mux.HandleFunc("/VolumeDriver.List", func(w http.ResponseWriter, r *http.Request) {
		entries, _ := os.ReadDir(root)
		vs := []volume{}
		for _, e := range entries {
			vs = append(vs, volume{e.Name(), path(e.Name())})
		}
		reply(w, map[string]any{"Volumes": vs, "Err": ""})
	})
	log.Fatal(http.Serve(l, mux))
}
