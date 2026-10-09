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
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || exit 2
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || exit 2
[[ "$use_secret" == yes || "$use_secret" == no ]] || exit 2
[[ "$mode" == activate || "$mode" == check ]] || exit 2

exec 9>/var/lib/onmaul/deploy.lock
flock -n 9 || { printf 'Another deployment is running.\n' >&2; exit 1; }
archive="/var/lib/onmaul/$release.tar.gz"
release_dir="/opt/onmaul/releases/$release"
[[ ! -e "$release_dir" ]] || { printf 'Release already exists.\n' >&2; exit 1; }
aws s3 cp "s3://$bucket/releases/$release/app.tar.gz" "$archive" --region "$region" --only-show-errors
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
install -d -m 0750 -o onmaul -g onmaul "$release_dir"
tar -xzf "$archive" -C "$release_dir" --no-same-owner
chown -R onmaul:onmaul "$release_dir"
runuser -u onmaul -- bash -c 'cd "$1" && /usr/bin/npm-24 ci --ignore-scripts --no-audit --no-fund --cache /var/lib/onmaul/.npm' bash "$release_dir"

if [[ "$mode" == check ]]; then
  # Verify Linux dependencies and loopback HTTP without activating the public application.
  runuser -u onmaul -- bash -c 'cd "$1" && exec env ON_EXECUTION_MODE=demo ON_PORT=18090 ON_JOURNAL_DIR=/var/lib/onmaul/check-journal /usr/bin/node-24 --import=tsx server/src/main.ts' bash "$release_dir" > /var/lib/onmaul/check-server.log 2>&1 &
  checker=$!
  finish_check() {
    kill "$checker" 2>/dev/null || true
    wait "$checker" 2>/dev/null || true
    rm -f "$archive"
  }
  trap finish_check EXIT
  ready=no
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:18090/api/health > /var/lib/onmaul/check-health.json; then
      if /usr/bin/node-24 -e 'const f=require("node:fs"); const v=JSON.parse(f.readFileSync("/var/lib/onmaul/check-health.json","utf8")); if(v.ok!==true || v.executionMode!=="demo") process.exit(1)'; then
        ready=yes
        break
      fi
    fi
    sleep 1
  done
  [[ "$ready" == yes ]]
  curl --fail --silent --max-time 5 http://127.0.0.1:18090/ > /var/lib/onmaul/check-index.html
  /usr/bin/node-24 -e 'const f=require("node:fs"); if(!f.readFileSync("/var/lib/onmaul/check-index.html","utf8").includes("<html")) process.exit(1)'
  systemctl is-active onmaul-cert-renew.timer
  printf 'S3 download, archive checksum, Linux dependencies, loopback API and frontend passed. Public application remains inactive.\n'
  exit 0
fi

# Secret values are read on EC2 and redirected to a private file, never sent in SSM commands.
new_env=$(mktemp /etc/onmaul/runtime.env.XXXXXX)
trap 'rm -f "$new_env"' EXIT
if [[ "$use_secret" == yes ]]; then
  aws secretsmanager get-secret-value --region "$region" --secret-id "$secret_arn" \
    --query SecretString --output text > "$new_env"
else
  : > "$new_env"
fi
cat >> "$new_env" <<'ENV'

# Deployment settings. Server binds only to loopback; Nginx provides HTTPS.
ON_PORT=8090
ON_JOURNAL_DIR=/var/lib/onmaul/journal
ENV
chown onmaul:onmaul "$new_env"
chmod 0600 "$new_env"

previous=$(readlink /opt/onmaul/current || true)
had_env=no
if [[ -f /etc/onmaul/runtime.env ]]; then
  cp -p /etc/onmaul/runtime.env /etc/onmaul/runtime.env.previous
  had_env=yes
fi
cp -p /etc/nginx/onmaul-app-location.conf /etc/nginx/onmaul-app-location.conf.previous
switched=no
rollback() {
  local result=$?
  trap - ERR
  if [[ "$switched" == yes ]]; then
    if [[ "$had_env" == yes ]]; then
      cp -p /etc/onmaul/runtime.env.previous /etc/onmaul/runtime.env
    fi
    if [[ -n "$previous" ]]; then
      ln -sfn "$previous" /opt/onmaul/current.next
      mv -Tf /opt/onmaul/current.next /opt/onmaul/current
      systemctl restart onmaul || true
    else
      systemctl stop onmaul || true
      rm -f /opt/onmaul/current
    fi
    cp -p /etc/nginx/onmaul-app-location.conf.previous /etc/nginx/onmaul-app-location.conf
    nginx -t && systemctl reload nginx || true
  fi
  printf 'Deployment failed; the previous release was restored when available.\n' >&2
  exit "$result"
}
trap rollback ERR
mv -f "$new_env" /etc/onmaul/runtime.env
ln -sfn "$release_dir" /opt/onmaul/current.next
mv -Tf /opt/onmaul/current.next /opt/onmaul/current
switched=yes
systemctl enable onmaul
systemctl restart onmaul
ready=no
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8090/api/health > /var/lib/onmaul/health.json; then
    if /usr/bin/node-24 -e 'const f=require("node:fs"); if(JSON.parse(f.readFileSync("/var/lib/onmaul/health.json","utf8")).ok!==true) process.exit(1)'; then
      ready=yes
      break
    fi
  fi
  sleep 1
done
[[ "$ready" == yes ]]
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
rm -f "$archive"
printf 'Activated release %s\n' "$release"
