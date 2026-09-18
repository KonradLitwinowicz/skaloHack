#!/usr/bin/env bash
# Wysyla biezacy stan projektu na VPS halfycraft i przebudowuje stack.
#   ./deploy-vps.sh          - synchronizuj + przebuduj + restart aplikacji
#   ./deploy-vps.sh --sync   - tylko wyslij pliki (bez przebudowy)
#   ./deploy-vps.sh --db     - wgraj na serwer aktualna lokalna baze (nadpisuje zdalna!)
#   ./deploy-vps.sh --logs   - podglad logow aplikacji
#   ./deploy-vps.sh --status - status kontenerow
set -euo pipefail

HOST=halfycraft
REMOTE=/opt/open-mercato
COMPOSE="docker compose -f docker-compose.fullapp.yml"
SERVICES="app postgres redis meilisearch"

case "${1:-deploy}" in
  --logs)   exec ssh "$HOST" "docker logs -f --tail 100 openmercato-vps-app-1" ;;
  --status) exec ssh "$HOST" "cd $REMOTE && $COMPOSE ps" ;;
  --db)
    echo "!! To nadpisze cala baze na serwerze danymi z lokalnego mercato-postgres."
    read -r -p "Na pewno? [tak/nie] " odp
    [ "$odp" = "tak" ] || { echo "Przerwane."; exit 1; }
    TMP=$(mktemp)
    echo "==> Zrzut lokalnej bazy"
    docker exec mercato-postgres pg_dump -U postgres -d open-mercato -Fc --no-owner --no-acl > "$TMP"
    echo "==> Wysylanie ($(du -h "$TMP" | cut -f1))"
    scp -q "$TMP" "$HOST:$REMOTE/mercato.dump"
    rm -f "$TMP"
    echo "==> Odtwarzanie na serwerze"
    ssh "$HOST" "cd $REMOTE && $COMPOSE stop app"
    ssh "$HOST" "docker exec mercato-postgres-vps psql -U postgres -d postgres -c 'DROP DATABASE IF EXISTS \"open-mercato\";' -c 'CREATE DATABASE \"open-mercato\";'"
    ssh "$HOST" "docker cp $REMOTE/mercato.dump mercato-postgres-vps:/tmp/mercato.dump"
    ssh "$HOST" "docker exec mercato-postgres-vps pg_restore -U postgres -d open-mercato --no-owner --no-acl -j 4 /tmp/mercato.dump"
    ssh "$HOST" "cd $REMOTE && $COMPOSE start app"
    echo "==> Baza wgrana. Pamietaj: hasla uzytkownikow sa teraz takie jak lokalnie."
    exit 0 ;;
esac

echo "==> Wysylanie plikow na $HOST:$REMOTE"
rsync -az --delete --info=stats1 \
  --exclude='node_modules' --exclude='**/node_modules' \
  --exclude='.next' --exclude='**/.next' \
  --exclude='.turbo' --exclude='**/.turbo' \
  --exclude='.mercato' --exclude='dist' --exclude='**/dist' \
  --exclude='coverage' --exclude='**/coverage' \
  --exclude='.git' --exclude='.yarn/install-state.gz' \
  --exclude='.env' --exclude='apps/mercato/.env' \
  --exclude='certs' --exclude='storage' --exclude='apps/mercato/storage' \
  --exclude='.queue' --exclude='**/.queue' --exclude='*.log' \
  --exclude='build.log' --exclude='deploy-vps.sh' \
  ./ "$HOST:$REMOTE/"

if [ "${1:-deploy}" = "--sync" ]; then
  echo "==> Gotowe (tylko synchronizacja)."
  exit 0
fi

echo "==> Przebudowa i restart (to trwa kilka minut)"
ssh "$HOST" "cd $REMOTE && $COMPOSE up --build -d $SERVICES"

echo "==> Status"
ssh "$HOST" "cd $REMOTE && $COMPOSE ps --format 'table {{.Name}}\t{{.Status}}'"
echo "==> Gotowe. UI: http://162.55.103.177:3100"
