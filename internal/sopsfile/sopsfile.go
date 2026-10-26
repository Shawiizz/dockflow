// Package sopsfile reads and writes SOPS files encrypted with age (ADR-0012): flat maps of
// secrets, compatible with the sops command. It implements the format on age's library alone,
// without the SOPS library and the cloud KMS clients it brings.
package sopsfile

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"
	"go.yaml.in/yaml/v3"
)

// Version is the sops format version written in new files.
const Version = "3.9.0"

// UnencryptedSuffix is the default of sops: keys ending with it stay in clear.
const UnencryptedSuffix = "_unencrypted"

// File is a decrypted SOPS file: its values in order, and what re-encrypting it needs.
type File struct {
	Keys       []string
	Values     map[string]string
	Recipients []string
	meta       metadata
}

type ageKey struct {
	Recipient string `yaml:"recipient"`
	Enc       string `yaml:"enc"`
}

type metadata struct {
	ShamirThreshold   int              `yaml:"shamir_threshold,omitempty"`
	KeyGroups         []map[string]any `yaml:"key_groups,omitempty"`
	KMS               []map[string]any `yaml:"kms,omitempty"`
	GCPKMS            []map[string]any `yaml:"gcp_kms,omitempty"`
	AzureKV           []map[string]any `yaml:"azure_kv,omitempty"`
	HCVault           []map[string]any `yaml:"hc_vault,omitempty"`
	Age               []ageKey         `yaml:"age,omitempty"`
	LastModified      string           `yaml:"lastmodified"`
	MAC               string           `yaml:"mac"`
	PGP               []map[string]any `yaml:"pgp,omitempty"`
	UnencryptedSuffix string           `yaml:"unencrypted_suffix,omitempty"`
	EncryptedSuffix   string           `yaml:"encrypted_suffix,omitempty"`
	UnencryptedRegex  string           `yaml:"unencrypted_regex,omitempty"`
	EncryptedRegex    string           `yaml:"encrypted_regex,omitempty"`
	MACOnlyEncrypted  bool             `yaml:"mac_only_encrypted,omitempty"`
	Version           string           `yaml:"version"`
}

// macOnlyEncryptedInit starts the MAC of files with mac_only_encrypted: sha256("sops"), as sops
// does.
var macOnlyEncryptedInit = func() []byte { s := sha256.Sum256([]byte("sops")); return s[:] }()

// Decrypt reads a SOPS file with one of identities.
func Decrypt(data []byte, identities []age.Identity) (*File, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("not YAML: %w", err)
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("not a map of secrets")
	}
	root := doc.Content[0]
	f := &File{Values: map[string]string{}}
	type entry struct {
		key  string
		node *yaml.Node
	}
	var entries []entry
	var metaNode *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		k, v := root.Content[i].Value, root.Content[i+1]
		if k == "sops" {
			metaNode = v
			continue
		}
		if v.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("%s is not a plain value: Dockflow reads flat maps of secrets", k)
		}
		entries = append(entries, entry{k, v})
	}
	if metaNode == nil {
		return nil, errors.New("no sops metadata: the file is not encrypted")
	}
	if err := metaNode.Decode(&f.meta); err != nil {
		return nil, fmt.Errorf("sops metadata: %w", err)
	}
	m := &f.meta
	switch {
	case len(m.KeyGroups) > 0 || m.ShamirThreshold > 0:
		return nil, errors.New("key groups are not supported: use age recipients")
	case len(m.Age) == 0:
		return nil, errors.New("the file has no age recipient: Dockflow reads files encrypted with age only")
	}
	key, err := dataKey(m.Age, identities)
	if err != nil {
		return nil, err
	}
	h := sha512.New()
	if m.MACOnlyEncrypted {
		h.Write(macOnlyEncryptedInit)
	}
	for _, e := range entries {
		f.Keys = append(f.Keys, e.key)
		encrypted := m.encrypts(e.key)
		var plain, macBytes string
		if encrypted {
			v, typ, err := decryptValue(e.node.Value, key, e.key+":")
			if err != nil {
				return nil, fmt.Errorf("%s: %w", e.key, err)
			}
			plain, macBytes = valueForm(v, typ), macForm(v, typ)
		} else {
			plain, macBytes = e.node.Value, macForm(e.node.Value, scalarType(e.node))
		}
		if !m.MACOnlyEncrypted || encrypted {
			h.Write([]byte(macBytes))
		}
		f.Values[e.key] = plain
	}
	mac, _, err := decryptValue(m.MAC, key, m.LastModified)
	if err != nil {
		return nil, fmt.Errorf("the MAC cannot be decrypted: %w", err)
	}
	if !strings.EqualFold(mac, fmt.Sprintf("%X", h.Sum(nil))) {
		return nil, errors.New("the MAC does not match: the file was changed without sops")
	}
	for _, a := range m.Age {
		f.Recipients = append(f.Recipients, a.Recipient)
	}
	return f, nil
}

func (m *metadata) encrypts(key string) bool {
	encrypted := m.UnencryptedSuffix == "" || !strings.HasSuffix(key, m.UnencryptedSuffix)
	if m.EncryptedSuffix != "" {
		encrypted = strings.HasSuffix(key, m.EncryptedSuffix)
	}
	if m.UnencryptedRegex != "" {
		if ok, _ := regexp.MatchString(m.UnencryptedRegex, key); ok {
			encrypted = false
		}
	}
	if m.EncryptedRegex != "" {
		ok, _ := regexp.MatchString(m.EncryptedRegex, key)
		encrypted = ok
	}
	return encrypted
}

// dataKey decrypts the file's data key with the first identity that opens one recipient's copy.
func dataKey(keys []ageKey, identities []age.Identity) ([]byte, error) {
	if len(identities) == 0 {
		return nil, errors.New("no age key to decrypt it: set SOPS_AGE_KEY or SOPS_AGE_KEY_FILE, or write the key to " + DefaultKeyFile())
	}
	for _, k := range keys {
		r, err := age.Decrypt(armor.NewReader(strings.NewReader(k.Enc)), identities...)
		if err != nil {
			continue
		}
		b, err := io.ReadAll(r)
		if err == nil && len(b) == 32 {
			return b, nil
		}
	}
	return nil, errors.New("none of the age keys given can decrypt it")
}

var encRE = regexp.MustCompile(`^ENC\[AES256_GCM,data:(.*),iv:(.+),tag:(.+),type:(.+)\]$`)

// decryptValue opens an ENC[AES256_GCM,…] value; an empty one is an empty string, as in sops.
func decryptValue(s string, key []byte, aad string) (string, string, error) {
	if s == "" {
		return "", "str", nil
	}
	m := encRE.FindStringSubmatch(s)
	if m == nil {
		return "", "", errors.New("not a sops-encrypted value")
	}
	var parts [3][]byte
	for i := range parts {
		b, err := base64.StdEncoding.DecodeString(m[i+1])
		if err != nil {
			return "", "", fmt.Errorf("invalid base64: %w", err)
		}
		parts[i] = b
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(parts[1]))
	if err != nil {
		return "", "", err
	}
	plain, err := gcm.Open(nil, parts[1], append(parts[0], parts[2]...), []byte(aad))
	if err != nil {
		return "", "", errors.New("cannot decrypt: wrong key or changed file")
	}
	return string(plain), m[4], nil
}

// valueForm is a decrypted value as the file's YAML would show it: sops stores a bool as True.
func valueForm(v, typ string) string {
	if typ == "bool" {
		if b, err := strconv.ParseBool(v); err == nil {
			return strconv.FormatBool(b)
		}
	}
	return v
}

// macForm is how sops hashes a value of a type: its Go value printed back.
func macForm(v, typ string) string {
	switch typ {
	case "int":
		if n, err := strconv.Atoi(v); err == nil {
			return strconv.Itoa(n)
		}
	case "float":
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return strconv.FormatFloat(n, 'f', -1, 64)
		}
	case "bool":
		if b, err := strconv.ParseBool(v); err == nil {
			if b {
				return "True"
			}
			return "False"
		}
	}
	return v
}

func scalarType(n *yaml.Node) string {
	switch n.Tag {
	case "!!int":
		return "int"
	case "!!float":
		return "float"
	case "!!bool":
		return "bool"
	}
	return "str"
}

// Encrypt writes values, in the order of keys, as a SOPS file for recipients.
func Encrypt(keys []string, values map[string]string, recipients []string, now time.Time) ([]byte, error) {
	if len(recipients) == 0 {
		return nil, errors.New("no age recipient to encrypt for")
	}
	var parsed []age.Recipient
	for _, r := range recipients {
		p, err := age.ParseX25519Recipient(r)
		if err != nil {
			return nil, fmt.Errorf("%s is not an age recipient: %w", r, err)
		}
		parsed = append(parsed, p)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	m := metadata{LastModified: now.UTC().Format(time.RFC3339), UnencryptedSuffix: UnencryptedSuffix, Version: Version}
	for i, p := range parsed {
		var buf bytes.Buffer
		aw := armor.NewWriter(&buf)
		w, err := age.Encrypt(aw, p)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(key); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
		if err := aw.Close(); err != nil {
			return nil, err
		}
		m.Age = append(m.Age, ageKey{Recipient: recipients[i], Enc: buf.String()})
	}
	root := &yaml.Node{Kind: yaml.MappingNode}
	h := sha512.New()
	for _, k := range keys {
		v := values[k]
		h.Write([]byte(v))
		out := v
		if m.encrypts(k) {
			var err error
			if out, err = encryptValue(v, key, k+":"); err != nil {
				return nil, err
			}
		}
		root.Content = append(root.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: k},
			&yaml.Node{Kind: yaml.ScalarNode, Value: out, Tag: "!!str"})
	}
	mac, err := encryptValue(fmt.Sprintf("%X", h.Sum(nil)), key, m.LastModified)
	if err != nil {
		return nil, err
	}
	m.MAC = mac
	var meta yaml.Node
	if err := meta.Encode(m); err != nil {
		return nil, err
	}
	root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "sops"}, &meta)
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(4)
	if err := enc.Encode(&yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func encryptValue(v string, key []byte, aad string) (string, error) {
	if v == "" {
		return "", nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, 32)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 32)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(v), []byte(aad))
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("ENC[AES256_GCM,data:%s,iv:%s,tag:%s,type:str]", b64(ct), b64(iv), b64(tag)), nil
}

// Identities are the age keys sops would use: SOPS_AGE_KEY, SOPS_AGE_KEY_FILE, then the
// user's keys file.
func Identities(getenv func(string) string) ([]age.Identity, error) {
	var out []age.Identity
	if v := getenv("SOPS_AGE_KEY"); v != "" {
		ids, err := age.ParseIdentities(strings.NewReader(v))
		if err != nil {
			return nil, fmt.Errorf("SOPS_AGE_KEY: %w", err)
		}
		out = append(out, ids...)
	}
	files := []string{getenv("SOPS_AGE_KEY_FILE")}
	if files[0] == "" {
		files[0] = DefaultKeyFile()
	}
	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		ids, err := age.ParseIdentities(bytes.NewReader(b))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		out = append(out, ids...)
	}
	return out, nil
}

// DefaultKeyFile is where sops looks for age keys by default.
func DefaultKeyFile() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		if runtime.GOOS == "darwin" {
			dir = filepath.Join(home, "Library", "Application Support")
		} else {
			dir = filepath.Join(home, ".config")
		}
	}
	return filepath.Join(dir, "sops", "age", "keys.txt")
}
