#!/usr/bin/env bash
# Run the patched source-built Paseo daemon in place of the packaged one.
#
#   MODE=dev  ./paseo-source-switch.sh   -> boot on 127.0.0.1:6768 with a throwaway
#                                           home. Does not touch paseo.service or
#                                           the live ~/.paseo. Proves the build starts.
#   MODE=swap ./paseo-source-switch.sh   -> stop paseo.service, take over the real
#                                           100.64.0.5:6767 with the real PASEO_HOME,
#                                           and roll back automatically if it fails.
#
# Run this detached (systemd-run), never as a child of an agent session: MODE=swap
# kills the daemon that session is attached to.
set -uo pipefail

SRC=/home/fab/src/paseo-patch
SERVER_DIST=$SRC/packages/server/dist
LIVE_HOME=/home/fab/.paseo
DEV_HOME=$SRC/.dev/paseo-home
DEV_PORT=127.0.0.1:6768
SWAP_PORT=0.0.0.0:6767
UNIT=paseo-source
LOG=/home/fab/paseo-source-switch.log
MODE=${MODE:-dev}

note() { echo "$(date -Is) $*" | tee -a "$LOG"; }

fail_to_dev_unit() {
  note "rolling back: stopping $UNIT, restarting paseo.service"
  systemctl stop "$UNIT" 2>&1 | tee -a "$LOG"
  systemctl reset-failed "$UNIT" 2>/dev/null
  systemctl start paseo.service 2>&1 | tee -a "$LOG"
  note "rollback done: paseo.service $(systemctl is-active paseo.service 2>&1)"
  [[ -n ${BACKUP_DIR:-} ]] && note "if it looks like migrated state broke 0.8.0: rsync -a --delete $BACKUP_DIR/ $LIVE_HOME/ && systemctl restart paseo.service"
}

wait_for_listen() { # addr timeout_s
  local addr=$1 deadline=$((SECONDS + $2))
  while (( SECONDS < deadline )); do
    if ss -tlnH 2>/dev/null | grep -qF "$addr"; then
      note "listening on $addr"
      return 0
    fi
    sleep 1
  done
  note "TIMEOUT waiting for $addr"
  return 1
}

start_unit() { # home port
  local home=$1 port=$2
  systemctl stop "$UNIT" 2>/dev/null
  systemctl reset-failed "$UNIT" 2>/dev/null
  # Without User=, systemd-run --system starts the unit as root, and every agent terminal it
  # spawns is root: files land root-owned in /home/fab, chromium needs --no-sandbox, and a
  # reboot that comes back on the packaged paseo.service (User=fab) silently changes the user.
  systemd-run --system --collect --unit="$UNIT" \
    --property=User=fab --property=Group=fab \
    --working-directory="$SRC/packages/server" \
    --property=Environment="HOME=/home/fab" \
    --property=Environment="PASEO_HOME=$home" \
    --property=Environment="PASEO_LISTEN=$port" \
    --property=StandardOutput=journal \
    --property=StandardError=journal \
    -- /usr/bin/node dist/scripts/supervisor-entrypoint.js 2>&1 | tee -a "$LOG"
}

note "=== MODE=$MODE"

if [[ ! -f $SERVER_DIST/scripts/supervisor-entrypoint.js ]]; then
  note "ABORT: $SERVER_DIST/scripts/supervisor-entrypoint.js missing - build did not finish"
  exit 1
fi
note "build present; upstream tree at $(git -C "$SRC" rev-parse --short HEAD)"

if [[ $MODE == dev ]]; then
  note "dev probe: booting source daemon on $DEV_PORT, home $DEV_HOME (live daemon untouched)"
  mkdir -p "$DEV_HOME"
  start_unit "$DEV_HOME" "$DEV_PORT"
  if wait_for_listen "$DEV_PORT" 90; then
    note "dev probe OK: source daemon serves $DEV_PORT"
    note "curl health: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://$DEV_PORT/api/health 2>&1)"
    exit 0
  fi
  note "dev probe FAILED"
  journalctl -u "$UNIT" --no-pager -n 60 2>&1 | tail -30 | tee -a "$LOG"
  systemctl stop "$UNIT" 2>/dev/null
  exit 1
fi

# --- MODE=swap -------------------------------------------------------------
# A daemon built from main may write state the packaged 0.8.0 cannot read back, so the
# rollback needs a known-good copy. Models are 985M of runtime assets, not state.
BACKUP_DIR=/home/fab/paseo-home-backup-$(date +%Y%m%d-%H%M%S)
if rsync -a --exclude=models/ --exclude='*daemon.log*' --exclude=runtime/ "$LIVE_HOME/" "$BACKUP_DIR/" 2>&1 | tee -a "$LOG"; then
  chmod 700 "$BACKUP_DIR"
  note "state backed up to $BACKUP_DIR ($(du -sh "$BACKUP_DIR" | cut -f1))"
  note "restore if 0.8.0 cannot read migrated state: rsync -a --delete $BACKUP_DIR/ $LIVE_HOME/"
else
  note "ABORT: backup failed - refusing to switch without a rollback point"
  exit 1
fi

note "stopping paseo.service (any session attached to it is dropped now)"
systemctl stop paseo.service 2>&1 | tee -a "$LOG"
note "paseo.service is $(systemctl is-active paseo.service 2>&1)"

# the packaged unit has no kill-leaked-children guarantee; drop strays before the
# pid lock is handed over
pids=$(systemctl show -p MainPID --value paseo.service 2>/dev/null)
if [[ -n $pids && $pids != 0 ]]; then
  sleep 2
  note "children of former MainPID $pids still alive: $(pgrep -P "$pids" | tr '\n' ' ')"
  pkill -P "$pids" 2>/dev/null
fi

start_unit "$LIVE_HOME" "$SWAP_PORT"
if wait_for_listen "$SWAP_PORT" 120; then
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$SWAP_PORT/api/health" 2>&1)
  if [[ $code == 2* ]]; then
    note "SWITCH OK: patched daemon owns $SWAP_PORT (health $code)."
    note "rollback if needed: systemctl stop $UNIT && systemctl start paseo.service"
    exit 0
  fi
  note "listening but health returned $code"
fi

journalctl -u "$UNIT" --no-pager -n 80 2>&1 | tail -40 | tee -a "$LOG"
fail_to_dev_unit
exit 1
