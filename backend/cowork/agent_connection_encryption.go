package cowork

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const agentConnectionCiphertextPrefix = "v1:"

func agentConnectionCipher(createKey bool) (cipher.AEAD, error) {
	encoded := strings.TrimSpace(os.Getenv("AGENT_CONNECTION_ENCRYPTION_KEY"))
	if encoded == "" {
		path := filepath.Join(filepath.Dir(stateFile), "agent-connection.key")
		data, err := os.ReadFile(path)
		if createKey && errors.Is(err, os.ErrNotExist) {
			if err := createAgentConnectionEncryptionKey(path); err != nil {
				return nil, err
			}
			data, err = os.ReadFile(path)
		}
		if err != nil {
			return nil, err
		}
		encoded = strings.TrimSpace(string(data))
	}

	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, errors.New("Agent Connection encryption key must be 32 base64-encoded bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithRandomNonce(block)
}

func createAgentConnectionEncryptionKey(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".agent-connection-key-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	var key [32]byte
	rand.Read(key[:])
	_, writeErr := f.WriteString(base64.StdEncoding.EncodeToString(key[:]))
	syncErr := f.Sync()
	if err := errors.Join(writeErr, syncErr, f.Close()); err != nil {
		return err
	}
	// Publish a complete key without replacing one created by another process.
	if err := os.Link(f.Name(), path); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func sealAgentConnectionKey(aead cipher.AEAD, workspaceID, credential string) string {
	sealed := aead.Seal(nil, nil, []byte(credential), []byte(workspaceID))
	return agentConnectionCiphertextPrefix + base64.RawStdEncoding.EncodeToString(sealed)
}

func openAgentConnectionKey(aead cipher.AEAD, workspaceID, stored string) (string, error) {
	encoded, ok := strings.CutPrefix(stored, agentConnectionCiphertextPrefix)
	if !ok {
		return "", errors.New("unknown Agent Connection ciphertext format")
	}
	sealed, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	credential, err := aead.Open(nil, nil, sealed, []byte(workspaceID))
	return string(credential), err
}

func migrateAgentConnectionKeys(d *database) error {
	hasPlaintext, hasCiphertext := false, false
	for _, value := range d.AgentConnectionKeys {
		if agentConnectionKeyPattern.MatchString(value) {
			hasPlaintext = true
		} else {
			hasCiphertext = true
		}
	}
	if !hasPlaintext {
		return nil
	}
	aead, err := agentConnectionCipher(!hasCiphertext)
	if err != nil {
		return err
	}
	for workspaceID, value := range d.AgentConnectionKeys {
		if agentConnectionKeyPattern.MatchString(value) {
			d.AgentConnectionKeys[workspaceID] = sealAgentConnectionKey(aead, workspaceID, value)
		} else if _, err := openAgentConnectionKey(aead, workspaceID, value); err != nil {
			return err
		}
	}
	return nil
}
