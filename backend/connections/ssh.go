package connections

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

var sshHostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)
var errSSHHostKey = errors.New("SSH_HOST_KEY_MISMATCH")

func (a *app) createSSH(w http.ResponseWriter, r *http.Request, owner, _ string) {
	var in struct {
		Host        string `json:"host"`
		Port        int    `json:"port"`
		User        string `json:"user"`
		PrivateKey  string `json:"private_key"`
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		http.Error(w, "Invalid SSH connection", http.StatusBadRequest)
		return
	}
	in.Host = strings.TrimSpace(in.Host)
	in.User = strings.TrimSpace(in.User)
	in.Fingerprint = strings.TrimSpace(in.Fingerprint)
	if in.Port == 0 {
		in.Port = 22
	}
	if _, err := netip.ParseAddr(in.Host); err != nil && !sshHostPattern.MatchString(in.Host) {
		http.Error(w, "Enter a hostname or IP address", http.StatusBadRequest)
		return
	}
	if in.Port < 1 || in.Port > 65535 || in.User == "" || len(in.User) > 255 || strings.ContainsAny(in.User, "\x00\r\n") {
		http.Error(w, "Enter a valid SSH username and port", http.StatusBadRequest)
		return
	}
	encoded, ok := strings.CutPrefix(in.Fingerprint, "SHA256:")
	fingerprint, err := base64.RawStdEncoding.Strict().DecodeString(encoded)
	if !ok || err != nil || len(fingerprint) != 32 || base64.RawStdEncoding.EncodeToString(fingerprint) != encoded {
		http.Error(w, "Enter the server's SHA256 host-key fingerprint", http.StatusBadRequest)
		return
	}
	if _, err := ssh.ParsePrivateKey([]byte(in.PrivateKey)); err != nil {
		http.Error(w, "Enter a valid SSH private key without a passphrase", http.StatusBadRequest)
		return
	}

	id := randomID()
	_, err = a.db.ExecContext(r.Context(), `
		INSERT INTO connections(id,owner_id,kind,credential,ssh_host,ssh_port,ssh_user,ssh_fingerprint)
		VALUES ($1,$2,'ssh',$3,$4,$5,$6,$7)`,
		id, owner, a.sealCredential(owner, id, in.PrivateKey), in.Host, in.Port, in.User, in.Fingerprint)
	if err != nil {
		http.Error(w, "Could not save SSH connection", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type sshRunInput struct {
	ConnectionID string `json:"connection_id" jsonschema:"SSH connection ID from list_connections"`
	Command      string `json:"command" jsonschema:"Non-interactive shell command to run on the machine"`
}

type sshRunOutput struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated"`
}

func (a *app) runSSH(ctx context.Context, p principal, in sshRunInput) (sshRunOutput, error) {
	if strings.TrimSpace(in.Command) == "" || len(in.Command) > 8192 || strings.ContainsRune(in.Command, 0) {
		return sshRunOutput{}, errors.New("INVALID_COMMAND")
	}
	var host, user, fingerprint string
	var port int
	var encrypted []byte
	err := a.db.QueryRowContext(ctx, `
		SELECT c.ssh_host,c.ssh_port,c.ssh_user,c.ssh_fingerprint,c.credential FROM connections c
		JOIN connection_access g ON g.owner_id=c.owner_id AND g.connection_id=c.id
		WHERE c.owner_id=$1 AND c.id=$2 AND g.client_id=$3 AND c.kind='ssh'`,
		p.owner, in.ConnectionID, p.client).Scan(&host, &port, &user, &fingerprint, &encrypted)
	if err != nil {
		return sshRunOutput{}, errors.New("CONNECTION_UNAVAILABLE")
	}
	privateKey, err := a.openCredential(p.owner, in.ConnectionID, encrypted)
	if err != nil {
		return sshRunOutput{}, errors.New("CREDENTIAL_UNAVAILABLE")
	}
	signer, err := ssh.ParsePrivateKey([]byte(privateKey))
	if err != nil {
		return sshRunOutput{}, errors.New("CREDENTIAL_UNAVAILABLE")
	}
	return executeSSH(ctx, net.JoinHostPort(host, strconv.Itoa(port)), user, fingerprint, signer, in.Command)
}

func executeSSH(ctx context.Context, address, user, fingerprint string, signer ssh.Signer, command string) (sshRunOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return sshRunOutput{}, errors.New("SSH_CONNECTION_FAILED")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return sshRunOutput{}, errors.New("SSH_CONNECTION_FAILED")
	}
	transport, channels, requests, err := ssh.NewClientConn(conn, address, &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyAlgorithms: []string{
			ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
			ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256,
		},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if ssh.FingerprintSHA256(key) != fingerprint {
				return errSSHHostKey
			}
			return nil
		},
	})
	if err != nil {
		if errors.Is(err, errSSHHostKey) {
			return sshRunOutput{}, errSSHHostKey
		}
		return sshRunOutput{}, errors.New("SSH_HANDSHAKE_FAILED")
	}
	client := ssh.NewClient(transport, channels, requests)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return sshRunOutput{}, errors.New("SSH_SESSION_FAILED")
	}
	defer session.Close()
	var stdout, stderr sshOutputBuffer
	session.Stdout, session.Stderr = &stdout, &stderr
	output := sshRunOutput{}
	if err := session.Run(command); err != nil {
		var exit *ssh.ExitError
		if !errors.As(err, &exit) {
			return sshRunOutput{}, errors.New("SSH_COMMAND_INCOMPLETE")
		}
		output.ExitCode = exit.ExitStatus()
	}
	output.Stdout = stdout.buffer.String()
	output.Stderr = stderr.buffer.String()
	output.Truncated = stdout.truncated || stderr.truncated
	return output, nil
}

type sshOutputBuffer struct {
	buffer    bytes.Buffer
	truncated bool
}

func (b *sshOutputBuffer) Write(data []byte) (int, error) {
	const limit = 64 << 10
	n := min(len(data), limit-b.buffer.Len())
	b.buffer.Write(data[:n])
	b.truncated = b.truncated || n < len(data)
	return len(data), nil
}
