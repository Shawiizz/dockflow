package sopsfile

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

// testdata/test-key.txt is a key made for these tests only; testdata/sops-cli.sops.yaml was
// written by `sops encrypt --age` 3.13.3 from a file with every scalar type.
func identities(t *testing.T) []age.Identity {
	t.Helper()
	ids, err := Identities(func(k string) string {
		if k == "SOPS_AGE_KEY_FILE" {
			return "testdata/test-key.txt"
		}
		return ""
	})
	if err != nil || len(ids) != 1 {
		t.Fatalf("test key: %v %v", ids, err)
	}
	return ids
}

func TestDecryptAFileOfTheSopsCommand(t *testing.T) {
	data, _ := os.ReadFile("testdata/sops-cli.sops.yaml")
	f, err := Decrypt(data, identities(t))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"DB_PASSWORD": "p@ss: with # chars", "PORT": "5432", "RATIO": "1.5", "FLAG": "true",
		"EMPTY": "", "NOTE_unencrypted": "in clear", "MULTI": "line1\nline2",
	}
	for k, v := range want {
		if f.Values[k] != v {
			t.Fatalf("%s = %q, want %q", k, f.Values[k], v)
		}
	}
	if strings.Join(f.Keys, ",") != "DB_PASSWORD,PORT,RATIO,FLAG,EMPTY,NOTE_unencrypted,MULTI" {
		t.Fatalf("keys in file order: %v", f.Keys)
	}
	if len(f.Recipients) != 1 || !strings.HasPrefix(f.Recipients[0], "age1") {
		t.Fatalf("recipients: %v", f.Recipients)
	}
}

func TestChangedFileIsRefused(t *testing.T) {
	data, _ := os.ReadFile("testdata/sops-cli.sops.yaml")
	// a clear value changed by hand breaks the MAC
	changed := strings.Replace(string(data), "NOTE_unencrypted: in clear", "NOTE_unencrypted: changed", 1)
	if _, err := Decrypt([]byte(changed), identities(t)); err == nil || !strings.Contains(err.Error(), "MAC") {
		t.Fatalf("a changed file must be refused: %v", err)
	}
	other, _ := age.GenerateX25519Identity()
	if _, err := Decrypt(data, []age.Identity{other}); err == nil {
		t.Fatal("another key must not decrypt it")
	}
}

func TestEncryptThenDecrypt(t *testing.T) {
	ids := identities(t)
	recipient := ids[0].(*age.X25519Identity).Recipient().String()
	keys := []string{"B", "A", "EMPTY", "NOTE_unencrypted"}
	values := map[string]string{"B": "two", "A": "one: #1", "EMPTY": "", "NOTE_unencrypted": "visible"}
	data, err := Encrypt(keys, values, []string{recipient}, time.Date(2026, 10, 26, 22, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "one: #1") || !strings.Contains(string(data), "visible") {
		t.Fatalf("values must be encrypted, the _unencrypted one in clear:\n%s", data)
	}
	f, err := Decrypt(data, ids)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		if f.Values[k] != values[k] {
			t.Fatalf("%s = %q", k, f.Values[k])
		}
	}

	// the sops command reads it too, when it is installed (SOPS_BIN)
	bin := os.Getenv("SOPS_BIN")
	if bin == "" {
		t.Skip("SOPS_BIN not set: the sops command's check is skipped")
	}
	path := filepath.Join(t.TempDir(), "x.sops.yaml")
	os.WriteFile(path, data, 0o600)
	cmd := exec.Command(bin, "decrypt", path)
	cmd.Env = append(os.Environ(), "SOPS_AGE_KEY_FILE="+filepath.Join(must(os.Getwd()), "testdata/test-key.txt"))
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "A: 'one: #1'") || !strings.Contains(string(out), "B: two") {
		t.Fatalf("sops decrypt: %v\n%s", err, out)
	}
}

func must(s string, _ error) string { return s }
