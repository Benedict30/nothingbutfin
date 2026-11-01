#!/bin/sh
# Deploy to the server: copy the source, build the Docker image there, restart the container.
# Usage: deploy/deploy.sh [--settings-only] [user@host]   (default host: $DEPLOY_HOST, or the first line of deploy/.host)
#   --settings-only: just recreate the container so it reads /opt/fsv/app.env again
#                    (docker restart does NOT re-read the settings file)
# Server layout: /opt/fsv/src (source), /opt/fsv/app.env (settings, secrets),
#                /opt/fsv/cache and /opt/fsv/data (kept across deploys),
#                /opt/caddy (HTTPS proxy: Caddyfile from deploy/Caddyfile, certificates in data/).
# The app listens on 127.0.0.1:3000 only; Caddy serves HTTPS on 80/443 (deploy/Caddyfile, from Caddyfile.example).
set -eu
SETTINGS_ONLY=0
if [ "${1:-}" = "--settings-only" ]; then SETTINGS_ONLY=1; shift; fi
HOST="${1:-${DEPLOY_HOST:-$(head -n1 "$(dirname "$0")/.host" 2>/dev/null)}}"
[ -n "$HOST" ] || { echo "No server: pass user@host, set DEPLOY_HOST, or put it in deploy/.host"; exit 1; }
cd "$(dirname "$0")/.."
# one SSH connection for the whole deploy (each new login costs several round trips)
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$HOME/.ssh/fsv-%C -o ControlPersist=60"
ssh() { command ssh $SSH_OPTS "$@"; }
scp() { command scp $SSH_OPTS "$@"; }

if [ "$SETTINGS_ONLY" = 0 ]; then
echo "→ building the UI"
npm run build --silent >/dev/null
echo "→ copying to $HOST"
ssh "$HOST" 'mkdir -p /opt/fsv/src /opt/fsv/cache /opt/fsv/data && chown 1000:1000 /opt/fsv/cache /opt/fsv/data && touch /opt/fsv/app.env && chmod 600 /opt/fsv/app.env'
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules --exclude=cache --exclude=data --exclude=./web --exclude=./test --exclude=.claude \
    --exclude=.sec-user-agent --exclude=.anthropic-api-key -czf - . | ssh "$HOST" 'rm -rf /opt/fsv/src && mkdir -p /opt/fsv/src && tar -xzf - -C /opt/fsv/src'

echo "→ building image"
ssh "$HOST" 'cd /opt/fsv/src && docker build -q -t fsv:latest . >/dev/null && echo built'

fi

echo "→ (re)creating container"
ssh "$HOST" 'docker rm -f fsv >/dev/null 2>&1 || true
  docker run -d --name fsv --restart unless-stopped -p 127.0.0.1:3000:3000 \
    --env-file /opt/fsv/app.env \
    -v /opt/fsv/cache:/app/cache -v /opt/fsv/data:/app/data \
    --memory 512m fsv:latest >/dev/null
  docker image prune -f >/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs localhost:3000/api/health && echo && exit 0; sleep 1; done; echo "health check failed"; docker logs --tail 30 fsv; exit 1'

# Caddy (HTTPS in front of the app): update its config if it changed, start it if it isn't running
ssh "$HOST" 'mkdir -p /opt/caddy/data /opt/caddy/config'
scp -q deploy/Caddyfile "$HOST":/opt/caddy/Caddyfile.new
ssh "$HOST" 'true
  if ! cmp -s /opt/caddy/Caddyfile.new /opt/caddy/Caddyfile; then mv /opt/caddy/Caddyfile.new /opt/caddy/Caddyfile; changed=1; else rm /opt/caddy/Caddyfile.new; fi
  if ! docker ps -q --filter name=^caddy$ | grep -q .; then
    docker rm -f caddy >/dev/null 2>&1 || true
    docker run -d --name caddy --restart unless-stopped --network host \
      -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile:ro -v /opt/caddy/data:/data -v /opt/caddy/config:/config \
      caddy:2.10 >/dev/null && echo "caddy started"
  elif [ "${changed:-}" = 1 ]; then docker exec caddy caddy reload --config /etc/caddy/Caddyfile && echo "caddy reloaded"; fi'
