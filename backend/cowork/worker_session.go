package cowork

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var workerSessionKey = []byte(key())

// The local worker may finish a turn after the browser's Clerk JWT expires.
func newWorkerSession(accountID string) string {
	payload := accountID + "." + strconv.FormatInt(time.Now().Add(3*time.Minute).Unix(), 10)
	return payload + "." + hex.EncodeToString(signWorkerSession(payload))
}

func signWorkerSession(payload string) []byte {
	mac := hmac.New(sha256.New, workerSessionKey)
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func workerAccount(r *http.Request, d *database, route string) (Account, bool) {
	if r.Method != http.MethodPost || (route != "task" && route != "task/schedule" && route != "reminder") {
		return Account{}, false
	}
	id, token, ok := strings.Cut(r.Header.Get("X-Cowork-Worker"), ".")
	expiry, signature, split := strings.Cut(token, ".")
	if !ok || !split || len(id) != 48 || len(signature) != 64 {
		return Account{}, false
	}
	expires, err := strconv.ParseInt(expiry, 10, 64)
	decoded, decodeErr := hex.DecodeString(signature)
	if err != nil || decodeErr != nil || expires < time.Now().Unix() || !hmac.Equal(decoded, signWorkerSession(id+"."+expiry)) {
		return Account{}, false
	}
	for _, account := range d.Accounts {
		if id == account.ID && account.ClerkID != "" {
			return account, true
		}
	}
	return Account{}, false
}
