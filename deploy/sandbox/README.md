# Developer sandbox pilot

This runner routes standalone UI tasks from one Developer workspace to one
preprovisioned KubeVirt VM. Each task renders a static title-and-brief preview in
graphical Chromium with a persistent profile, captures a screenshot, and publishes
the preview and screenshot through the existing task workflow.

## Guest

Use a Debian desktop VM backed by its own PVC. Assign a stable MAC, set
`runStrategy: Manual`, and use a masquerade interface with guest TCP port
8765. Restrict network ingress to the launcher pod so the desktop HTTP service
is available through Kubernetes port forwarding. The VM should have no Kubernetes
service-account volume or Cowork credentials.

Install `chromium xvfb xauth xdotool scrot python3`, copy `desktop.py` to
`/opt/cowork/desktop.py`, and create an unprivileged account with a home directory
on the persistent disk. Enable a systemd service with that account as `User`,
`PrivateTmp=true`, and this `ExecStart`:

```text
/usr/bin/xvfb-run -a -s "-screen 0 1280x800x24 -nolisten tcp" /usr/bin/python3 /opt/cowork/desktop.py
```

Boot once to install and warm the guest before connecting Cowork. The browser
profile is `~/.cowork-chromium` inside the VM.

## Broker and Cowork

On the broker host, give a dedicated Kubernetes identity namespace-scoped access
to get the pilot VMI, list launcher pods, create requests to `pods/portforward`,
and update the named VM's `virtualmachines/start` and `virtualmachines/stop`
subresources in `subresources.kubevirt.io`. Configure the broker's kubeconfig
to refresh credentials through its normal Kubernetes client flow.

Set `COWORK_SANDBOX_NAMESPACE`, `COWORK_SANDBOX_VM`, and
`COWORK_SANDBOX_TOKEN` before starting `python3 deploy/sandbox/broker.py`.
Run one broker process per pilot VM. It binds to `127.0.0.1:18766`. For
Coolify on a separate host, route to that listener through a private HTTPS
gateway. Use a random token shared only between Coolify and the broker.

Set these variables on the Mastra worker at runtime:

| Variable | Value |
| --- | --- |
| `COWORK_RUNNER` | `/app/deploy/sandbox/developer-runner.mjs` in the Coolify image |
| `COWORK_SANDBOX_WORKSPACE_ID` | The pilot Developer workspace ID |
| `COWORK_SANDBOX_TOKEN` | The broker's shared token |
| `COWORK_SANDBOX_URL` | Private HTTPS broker origin, or `http://127.0.0.1:18766` for same-host testing |
| `COWORK_SANDBOX_CA_PEM` | CA certificate in PEM format when the private broker uses a dedicated certificate |

Create a standalone UI task in the pilot workspace and check its plan,
preview and screenshot. Confirm the VM stops and the PVC remains bound, then
submit a second task to exercise a cold start against the same disk. Other
Developer tasks continue through the built-in runner.

The homelab broker manifest runs the same broker in the VM namespace with its
own Kubernetes service account. It requires the `sandbox-auth` token Secret,
`sandbox-tls` TLS Secret, and `sandbox-broker` ConfigMap containing `broker.py`.
It uses the desktop node's LAN address on port 31866 and allows ingress from the
Coolify and validation hosts. Set the runner's CA certificate to the public
certificate for this endpoint. Keep the VM disk's reclaim policy set to
`Retain` for the long-lived pilot and back up the node-local data separately.
