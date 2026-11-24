#!/usr/bin/env python3
"""Deploy successful main builds through the worker's private Coolify API."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen


APP = os.environ.get("COWORK_COOLIFY_APP_UUID", "")
IMAGE = "ghcr.io/iamwille-dev/cowork"
RUNS = (
    "https://api.github.com/repos/iamwille-dev/cowork/actions/workflows/coolify.yml/runs"
    "?branch=main&event=push&status=success&per_page=1"
)
ACTIVE = {"queued", "in_progress"}


def coolify(method, path, data=None):
    result = subprocess.run(
        ["/usr/local/bin/coolify-api", method, path, *(["-"] if data is not None else [])],
        input=json.dumps(data) if data is not None else None,
        text=True, stdout=subprocess.PIPE, check=True, timeout=20,
    )
    return json.loads(result.stdout)


def save(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state) + "\n")
    temporary.replace(path)


def main():
    if not re.fullmatch(r"[a-z0-9]{24}", APP):
        raise ValueError("Set COWORK_COOLIFY_APP_UUID to the production application UUID.")
    state_file = Path(os.environ["STATE_DIRECTORY"]) / "release.json"
    state = json.loads(state_file.read_text()) if state_file.is_file() else {}
    if state.get("status") in ACTIVE:
        deployment = state["deployment"]
        status = coolify("GET", f"/deployments/{deployment}")["status"]
        if status in ACTIVE:
            return
        print(f"Coolify deployment {deployment} for {state['sha']} is {status}.")
        save(state_file, {**state, "status": status})

    request = Request(RUNS, headers={"Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=10) as response:
        runs = json.load(response)["workflow_runs"]
    if not runs:
        return
    sha = runs[0]["head_sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("GitHub returned an invalid release SHA.")
    if state.get("sha") == sha:
        return

    app = coolify("GET", f"/applications/{APP}")
    if app["build_pack"] != "dockerimage" or app["docker_registry_image_name"] != IMAGE:
        raise ValueError("The Coolify application does not use the Cowork registry image.")
    history = coolify("GET", f"/deployments/applications/{APP}")["deployments"]
    if any(run["status"] in ACTIVE for run in history):
        return
    if not state and app["docker_registry_image_tag"] == sha and app["status"] == "running:healthy":
        save(state_file, {"sha": sha})
        print(f"Coolify is already serving {sha}.")
        return

    coolify("PATCH", f"/applications/{APP}", {"docker_registry_image_tag": sha})
    result = coolify("POST", "/deploy", {"uuid": APP, "force": True})
    deployment = next(item["deployment_uuid"] for item in result["deployments"] if item.get("resource_uuid") == APP)
    save(state_file, {"sha": sha, "deployment": deployment, "status": "queued"})
    print(f"Queued Coolify deployment {deployment} for {sha}.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, StopIteration, ValueError, subprocess.SubprocessError) as error:
        sys.exit(f"Cowork auto-deploy: {error}")
