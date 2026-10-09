#!/usr/bin/env bash
# Prepare the EC2 toolchain. This script never installs or starts the application.
set -euo pipefail
umask 077

[[ "$(uname -m)" == x86_64 ]] || { printf 'This runtime setup targets x86_64.\n' >&2; exit 2; }
exec 9>/var/lib/onmaul/deploy.lock
flock -n 9 || { printf 'Another deployment or runtime preparation is running.\n' >&2; exit 1; }
app_before=$(systemctl is-active onmaul.service || true)
app_enabled_before=$(systemctl is-enabled onmaul.service 2>/dev/null || true)
release_before=$(readlink /opt/onmaul/current || true)

dnf install -y nodejs24 nodejs24-npm python3.11 python3.11-pip docker git jq
command -v curl >/dev/null
command -v aws >/dev/null
install -d -m 0755 /usr/local/lib/docker/cli-plugins /etc/docker

workspace=$(mktemp -d /var/lib/onmaul/runtime-check.XXXXXX)
check_image="onmaul-runtime-check:$(date +%s)-$$"
cleanup() {
  docker image rm "$check_image" >/dev/null 2>&1 || true
  rm -rf "$workspace"
}
trap cleanup EXIT

# Official release assets, pinned by version and SHA-256. Updates are deliberate.
install_plugin() {
  local name=$1 url=$2 checksum=$3
  local destination="/usr/local/lib/docker/cli-plugins/$name"
  if [[ -f "$destination" ]] && printf '%s  %s\n' "$checksum" "$destination" | sha256sum -c - >/dev/null 2>&1; then
    return
  fi
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 10 --max-time 180 "$url" -o "$workspace/$name"
  printf '%s  %s\n' "$checksum" "$workspace/$name" | sha256sum -c -
  install -m 0755 "$workspace/$name" "$destination"
}
install_plugin docker-compose \
  https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-linux-x86_64 \
  40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a
install_plugin docker-buildx \
  https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64 \
  4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287

# Bound container logs on this 20 GiB disk. Preserve any existing daemon settings.
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  chmod 0644 /etc/docker/daemon.json
fi
dockerd --validate --config-file=/etc/docker/daemon.json
systemctl enable --now docker.service
systemctl is-active --quiet docker.service
systemctl is-enabled --quiet docker.service
containers_before=$(docker ps -q | sort)

/usr/bin/node-24 --version
/usr/bin/npm-24 --version
python3.11 --version
python3.11 -m pip --version
python3.11 -m venv "$workspace/python-venv"
"$workspace/python-venv/bin/python" -c 'import ssl; print("Python venv and TLS: OK")'
git --version
docker version
docker compose version
docker buildx version
docker info --format 'Docker storage={{.Driver}} logging={{.LoggingDriver}} cgroup={{.CgroupVersion}}'

# Cache the official Node base image and exercise Compose without app code or ports.
node_image=public.ecr.aws/docker/library/node:24-bookworm-slim
docker pull "$node_image"
cat > "$workspace/compose.yaml" <<'YAML'
services:
  runtime-check:
    image: public.ecr.aws/docker/library/node:24-bookworm-slim
    command: ["node", "--version"]
    user: "1000:1000"
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 32
    mem_limit: 128m
    cpus: 0.5
YAML
docker compose --project-name "onmaul-runtime-check-$$" -f "$workspace/compose.yaml" config --quiet
docker compose --project-name "onmaul-runtime-check-$$" -f "$workspace/compose.yaml" run --rm --no-deps runtime-check

# Verify BuildKit with a temporary scratch image; no application image is built.
install -d -m 0700 "$workspace/build"
printf 'runtime build check\n' > "$workspace/build/marker"
printf 'FROM scratch\nCOPY marker /runtime-marker\n' > "$workspace/build/Dockerfile"
docker buildx build --network=none --provenance=false --load --tag "$check_image" "$workspace/build"
docker image inspect "$check_image" >/dev/null
docker image rm "$check_image" >/dev/null

[[ "$(docker ps -q | sort)" == "$containers_before" ]] || { printf 'Unexpected running container after check.\n' >&2; exit 1; }
[[ "$(systemctl is-active onmaul.service || true)" == "$app_before" ]]
[[ "$(systemctl is-enabled onmaul.service 2>/dev/null || true)" == "$app_enabled_before" ]]
[[ "$(readlink /opt/onmaul/current || true)" == "$release_before" ]]
systemctl is-active --quiet nginx.service
systemctl is-active --quiet onmaul-cert-renew.timer

python3.11 - <<'PY'
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

def command(*args):
    return subprocess.check_output(args, text=True).strip()

facts = {
    'checked_at': datetime.now(timezone.utc).isoformat(),
    'node': command('/usr/bin/node-24', '--version'),
    'npm': command('/usr/bin/npm-24', '--version'),
    'python': command('python3.11', '--version'),
    'docker': command('docker', 'version', '--format', '{{.Server.Version}}'),
    'compose': command('docker', 'compose', 'version', '--short'),
    'buildx': command('docker', 'buildx', 'version'),
    'node_image_digest': command('docker', 'image', 'inspect', 'public.ecr.aws/docker/library/node:24-bookworm-slim', '--format', '{{index .RepoDigests 0}}'),
    'docker_enabled': True,
    'python_venv_verified': True,
    'compose_run_verified': True,
    'buildx_build_verified': True,
    'application_active': subprocess.run(['systemctl', 'is-active', '--quiet', 'onmaul.service']).returncode == 0,
    'running_container_count': len(command('docker', 'ps', '-q').splitlines()),
}
path = Path('/var/lib/onmaul/runtime-ready.json')
path.write_text(json.dumps(facts, indent=2) + '\n')
path.chmod(0o600)
print('RUNTIME_READY ' + json.dumps(facts))
PY
