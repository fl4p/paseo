#!/usr/bin/env bash
# Promote the staged unit file to the live one and make the source build the boot default.
# Run detached (systemd-run). Stopping the transient paseo-source unit drops any attached
# session for the few seconds the replacement takes to come up.
set -uo pipefail

SRC=/home/fab/src/paseo-patch
UNIT_SRC=$SRC/paseo-source.service
UNIT_DST=/etc/systemd/system/paseo-source.service
PORT=0.0.0.0:6767
LOG=/home/fab/paseo-unit-install.log

note() { echo "$(date -Is) $*" | tee -a "$LOG"; }

note "=== install source unit"

# 1. stop the transient instance first: a transient unit and a /etc unit of the same name
#    would otherwise race for the name during daemon-reload
systemctl stop paseo-source 2>&1 | tee -a "$LOG"
for _ in $(seq 1 20); do
  ss -tlnH 2>/dev/null | grep -qF "$PORT" || break
  sleep 1
done

# 2. install the real unit and let systemd replace the transient definition
install -m 0644 "$UNIT_SRC" "$UNIT_DST" || { note "ABORT: could not install unit"; systemctl start paseo.service; exit 1; }
systemctl daemon-reload
note "installed $UNIT_DST; $(systemctl cat paseo-source | head -1)"

# 3. start it and verify before touching the packaged unit's enable state
systemctl start paseo-source 2>&1 | tee -a "$LOG"
ok=0
for _ in $(seq 1 90); do
  if ss -tlnH 2>/dev/null | grep -qF "$PORT"; then
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$PORT/api/health" 2>&1)
    if [[ $code == 2* ]]; then ok=1; note "health $code on $PORT"; break; fi
  fi
  sleep 1
done

if [[ $ok != 1 ]]; then
  note "FAILED to come up; rolling back to paseo.service"
  journalctl -u paseo-source --no-pager -n 40 2>&1 | tail -20 | tee -a "$LOG"
  systemctl stop paseo-source 2>&1 | tee -a "$LOG"
  systemctl start paseo.service 2>&1 | tee -a "$LOG"
  note "rollback: paseo.service $(systemctl is-active paseo.service)"
  exit 1
fi

# 4. only now flip the boot default: enable the source unit, disable the packaged one
systemctl enable paseo-source 2>&1 | tee -a "$LOG"
systemctl disable paseo.service 2>&1 | tee -a "$LOG"
note "enabled=$([ "$(systemctl is-enabled paseo-source)" = enabled ] && echo paseo-source) paseo.service=$(systemctl is-enabled paseo.service)"
note "DONE: source build is the boot default; rollback = systemctl enable paseo.service && systemctl disable paseo-source && systemctl start paseo.service"
