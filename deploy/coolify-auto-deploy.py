#!/usr/bin/env python3
"""Queue builds from GitHub main through the worker's private Coolify API."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen


APP = os.environ.get("COWORK_COOLIFY_APP_UUID", "")
REPOSITORY = "https://github.com/iamwille-dev/cowork.git"
MAIN_REF = "https://api.github.com/repos/iamwille-dev/cowork/git/ref/heads/main"
ACTIVE = {"queued", "in_progress"}


def coolify(method, path, data=None):
    result = subprocess.run(
        ["/usr/local/bin/coolify-api", method, path, *(["-"] if data is not None else [])],
        input=json.dumps(data) if data is not None else None,
        text=True, stdout=subprocess.PIPE, check=True, timeout=25,
    )
    return json.loads(result.stdout)


def save(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state) + "\n")
    temporary.replace(path)


def main():
    if not re.fullmatch(r"[a-z0-9]{24}", APP):
        raise ValueError("Set COWORK_COOLIFY_APP_UUID to the production application UUID.")
    state_file = Path(os.environ["STATE_DIRECTORY"]) / "source-release.json"
    state = json.loads(state_file.read_text()) if state_file.is_file() else {}

    if state.get("status") in ACTIVE:
        deployment = state["deployment"]
        status = coolify("GET", f"/deployments/{deployment}")["status"]
        if status in ACTIVE:
            return
        print(f"Coolify deployment {deployment} for {state['sha']} is {status}.")
        save(state_file, {**state, "status": status})

    request = Request(MAIN_REF, headers={"Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=10) as response:
        sha = json.load(response)["object"]["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("GitHub returned an invalid commit SHA.")
    if state.get("sha") == sha:
        return

    path = f"/applications/{APP}"
    app = coolify("GET", path)
    if (app["build_pack"] != "dockerfile" or app["git_repository"].rstrip("/") != REPOSITORY
            or app["git_branch"] != "main" or app.get("docker_registry_image_name")):
        raise ValueError("Configure the Coolify application to build Cowork main from Git.")
    history = coolify("GET", f"/deployments/applications/{APP}")["deployments"]
    if any(run["status"] in ACTIVE for run in history):
        return
    if history and history[0].get("commit") == sha and history[0]["status"] == "finished":
        save(state_file, {"sha": sha, "status": "finished"})
        return

    coolify("PATCH", path, {"git_commit_sha": sha})
    result = coolify("POST", "/deploy", {"uuid": APP})
    deployment = next(item["deployment_uuid"] for item in result["deployments"] if item.get("resource_uuid") == APP)
    save(state_file, {"sha": sha, "deployment": deployment, "status": "queued"})
    print(f"Queued Coolify build {deployment} for {sha}.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, StopIteration, ValueError, subprocess.SubprocessError) as error:
        sys.exit(f"Cowork auto-deploy: {error}")
