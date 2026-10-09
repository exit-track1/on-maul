#!/usr/bin/env bash
set -euo pipefail
umask 077

domain=${1:?domain required}
[[ "$domain" =~ ^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$ ]] || exit 2
dnf install -y nginx nodejs24 nodejs24-npm python3.11 python3.11-pip
command -v aws >/dev/null
/usr/bin/node-24 --version

install -d -m 0750 -o onmaul -g onmaul /opt/onmaul/releases /var/lib/onmaul /etc/onmaul
install -d -m 0755 /var/www/onmaul-acme/.well-known/acme-challenge
if [[ ! -x /opt/onmaul-certbot/bin/certbot ]]; then
  python3.11 -m venv /opt/onmaul-certbot
  /opt/onmaul-certbot/bin/pip install --upgrade pip certbot
fi

if [[ ! -f /etc/nginx/onmaul-app-location.conf ]]; then
  cat > /etc/nginx/onmaul-app-location.conf <<'PENDING'
location / {
  default_type text/plain;
  return 503 'Application deployment pending\n';
}
PENDING
fi
if [[ ! -f /etc/nginx/nginx.conf.before-onmaul ]]; then
  cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.before-onmaul
fi
cat > /etc/nginx/nginx.conf <<'NGINX'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  server_tokens off;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  include /etc/nginx/onmaul-sites.conf;
}
NGINX

if [[ ! -s "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  cat > /etc/nginx/onmaul-sites.conf <<NGINX
server {
  listen 80 default_server;
  server_name $domain;
  location ^~ /.well-known/acme-challenge/ { root /var/www/onmaul-acme; }
  location = /infra-health { default_type text/plain; return 200 'onmaul infrastructure ready\\n'; }
  include /etc/nginx/onmaul-app-location.conf;
}
NGINX
  nginx -t
  systemctl reload nginx
fi

/opt/onmaul-certbot/bin/certbot certonly --webroot -w /var/www/onmaul-acme \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring --cert-name "$domain" -d "$domain"

cat > /etc/nginx/onmaul-sites.conf <<NGINX
server {
  listen 80 default_server;
  server_name $domain;
  location ^~ /.well-known/acme-challenge/ { root /var/www/onmaul-acme; }
  location / { return 301 https://$domain\$request_uri; }
}
server {
  listen 443 ssl default_server;
  server_name $domain;
  ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  location = /infra-health { default_type text/plain; return 200 'onmaul infrastructure ready\\n'; }
  include /etc/nginx/onmaul-app-location.conf;
}
NGINX
nginx -t
systemctl reload nginx

cat > /etc/systemd/system/onmaul-cert-renew.service <<'UNIT'
[Unit]
Description=Renew Onmaul HTTPS certificate
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/onmaul-certbot/bin/certbot renew --quiet --deploy-hook "/usr/sbin/nginx -t && /bin/systemctl reload nginx"
UNIT
cat > /etc/systemd/system/onmaul-cert-renew.timer <<'UNIT'
[Unit]
Description=Check Onmaul HTTPS certificate twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/onmaul.service <<'UNIT'
[Unit]
Description=Onmaul application
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=onmaul
Group=onmaul
WorkingDirectory=/opt/onmaul/current
Environment=NODE_ENV=production
ExecStart=/usr/bin/node-24 --env-file=/etc/onmaul/runtime.env --import=tsx server/src/main.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/onmaul
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now onmaul-cert-renew.timer
openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -noout -subject -dates
printf 'HTTPS and application service prepared. Application activation requires an explicit deploy command.\n'
