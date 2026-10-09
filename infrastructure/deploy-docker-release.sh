#!/usr/bin/env bash
set -euo pipefail
umask 077

region=${1:?region required}
bucket=${2:?bucket required}
release=${3:?release required}
checksum=${4:?checksum required}
secret_arn=${5:?secret ARN required}
use_secret=${6:?secret flag required}
mode=${7:-activate}
revision=${8:?source revision required}
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
[[ "$checksum" =~ ^[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$use_secret" == yes || "$use_secret" == no ]]
[[ "$mode" == activate || "$mode" == check ]]
exec 9>/var/lib/onmaul/deploy.lock
flock -n 9 || { printf 'Another deployment is running.\n' >&2; exit 1; }
systemctl is-active --quiet docker.service

archive="/var/lib/onmaul/$release.tar.gz"
release_dir="/opt/onmaul/releases/$release"
image="onmaul:$release"
checker="onmaul-check-$release"
[[ ! -e "$release_dir" ]] || { printf 'Release already exists.\n' >&2; exit 1; }
aws s3 cp "s3://$bucket/releases/$release/app.tar.gz" "$archive" --region "$region" --only-show-errors
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
install -d -m 0750 -o onmaul -g onmaul "$release_dir"
tar -xzf "$archive" -C "$release_dir" --no-same-owner
docker buildx build --provenance=false --load --file "$release_dir/infrastructure/Dockerfile" \
  --label "org.opencontainers.image.revision=$revision" --tag "$image" "$release_dir"

new_env=$(mktemp /etc/onmaul/runtime.env.XXXXXX)
check_state=$(mktemp -d /var/lib/onmaul/check-app-data.XXXXXX)
cleanup() {
  docker rm -f "$checker" >/dev/null 2>&1 || true
  rm -f "$new_env" "$archive"
  rm -rf "$check_state"
}
trap cleanup EXIT
if [[ "$use_secret" == yes ]]; then
  aws secretsmanager get-secret-value --region "$region" --secret-id "$secret_arn" \
    --query SecretString --output text > "$new_env"
else
  printf 'ON_EXECUTION_MODE=demo\nON_PHONE_ENABLED=no\n' > "$new_env"
fi
cat >> "$new_env" <<'ENV'
NODE_ENV=production
ON_PORT=8090
ON_PHONE_ENV=deployment
ON_JOURNAL_DIR=/var/lib/onmaul/app-data/journal
ON_LOCAL_DATA_DIR=/var/lib/onmaul/app-data/phone-settings
ON_PHONE_DATA_DIR=/var/lib/onmaul/app-data/phone-history
ENV
chown onmaul:onmaul "$new_env" "$check_state"
chmod 0600 "$new_env"
chmod 0750 "$check_state"
app_uid=$(id -u onmaul)
app_gid=$(id -g onmaul)

# Validate the candidate with a separate journal and demo settings before switching.
docker run -d --init --name "$checker" --network host --user "$app_uid:$app_gid" \
  --read-only --cap-drop ALL --security-opt no-new-privileges=true --pids-limit 256 \
  --memory 768m --memory-swap 768m --cpus 1.5 --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=$new_env,dst=/run/onmaul/runtime.env,readonly" \
  --mount "type=bind,src=$check_state,dst=/var/lib/onmaul/app-data" \
  -e ON_EXECUTION_MODE=demo -e ON_PHONE_ENABLED=no -e ON_PORT=18090 "$image" >/dev/null
wait_for_api() {
  local port=$1
  for attempt in {1..60}; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/health" > /var/lib/onmaul/docker-check-health.json; then
      if /usr/bin/node-24 -e 'const v=JSON.parse(require("node:fs").readFileSync("/var/lib/onmaul/docker-check-health.json","utf8"));if(v.ok!==true)process.exit(1)'; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}
wait_for_api 18090
curl --fail --silent --max-time 5 http://127.0.0.1:18090/ > /var/lib/onmaul/docker-check-index.html
/usr/bin/node-24 -e 'if(!require("node:fs").readFileSync("/var/lib/onmaul/docker-check-index.html","utf8").includes("<html"))process.exit(1)'
python3.11 - <<'PY'
import re
from urllib.request import urlopen
html = open('/var/lib/onmaul/docker-check-index.html').read()
assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
if not assets:
    raise RuntimeError('Frontend bundle references are missing.')
for path in assets:
    with urlopen('http://127.0.0.1:18090' + path, timeout=10) as response:
        expected = 'text/css' if path.endswith('.css') else 'javascript'
        if response.status != 200 or expected not in response.headers.get('Content-Type', ''):
            raise RuntimeError('Frontend asset response is invalid: ' + path)
        response.read()
print('Frontend JavaScript and CSS checks passed.')
PY
curl --fail --silent --max-time 5 http://127.0.0.1:18090/api/state > /dev/null
docker rm -f "$checker" >/dev/null
if [[ "$mode" == check ]]; then
  printf 'Docker image, loopback frontend and API passed; public application was not activated.\n'
  exit 0
fi

previous=$(readlink /opt/onmaul/current || true)
previous_active=$(systemctl is-active onmaul || true)
previous_enabled=$(systemctl is-enabled onmaul 2>/dev/null || true)
unit_backup="/etc/onmaul/onmaul.service.$release.previous"
env_backup="/etc/onmaul/runtime.env.$release.previous"
nginx_backup="/etc/onmaul/nginx-location.$release.previous"
cp -p /etc/systemd/system/onmaul.service "$unit_backup"
cp -p /etc/nginx/onmaul-app-location.conf "$nginx_backup"
had_env=no
if [[ -f /etc/onmaul/runtime.env ]]; then cp -p /etc/onmaul/runtime.env "$env_backup"; had_env=yes; fi
switched=no
rollback() {
  local result=$?
  trap - ERR
  if [[ "$switched" == yes ]]; then
    systemctl stop onmaul || true
    cp -p "$unit_backup" /etc/systemd/system/onmaul.service
    if [[ "$had_env" == yes ]]; then cp -p "$env_backup" /etc/onmaul/runtime.env; else rm -f /etc/onmaul/runtime.env; fi
    if [[ -n "$previous" ]]; then ln -sfn "$previous" /opt/onmaul/current; else rm -f /opt/onmaul/current; fi
    cp -p "$nginx_backup" /etc/nginx/onmaul-app-location.conf
    systemctl daemon-reload
    if [[ "$previous_enabled" == enabled ]]; then systemctl enable onmaul; else systemctl disable onmaul; fi
    if [[ "$previous_active" == active ]]; then systemctl start onmaul || true; fi
    nginx -t && systemctl reload nginx || true
  fi
  printf 'Docker deployment failed; previous application configuration restored.\n' >&2
  exit "$result"
}
trap rollback ERR
install -d -m 0750 -o onmaul -g onmaul /var/lib/onmaul/app-data
switched=yes
systemctl stop onmaul
mv -f "$new_env" /etc/onmaul/runtime.env
cat > /etc/systemd/system/onmaul.service <<UNIT
[Unit]
Description=Onmaul Docker application
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm --init --name onmaul-app --network host --user $app_uid:$app_gid --read-only --cap-drop ALL --security-opt no-new-privileges=true --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1.5 --tmpfs /tmp:rw,noexec,nosuid,size=64m --mount type=bind,src=/etc/onmaul/runtime.env,dst=/run/onmaul/runtime.env,readonly --mount type=bind,src=/var/lib/onmaul/app-data,dst=/var/lib/onmaul/app-data -e ON_PORT=8090 $image
ExecStop=/usr/bin/docker stop -t 20 onmaul-app
Restart=always
RestartSec=3
TimeoutStartSec=120
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
ln -sfn "$release_dir" /opt/onmaul/current
systemctl daemon-reload
systemctl enable --now onmaul.service
wait_for_api 8090
cat > /etc/nginx/onmaul-app-location.conf <<'NGINX'
location / {
  proxy_pass http://127.0.0.1:8090;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_buffering off;
  proxy_read_timeout 120s;
  client_max_body_size 1m;
}
NGINX
nginx -t
systemctl reload nginx
trap - ERR
printf 'Activated Docker release %s; source revision %s\n' "$release" "$revision"
docker inspect --format 'Container={{.Name}} image={{.Config.Image}} state={{.State.Status}}' onmaul-app
