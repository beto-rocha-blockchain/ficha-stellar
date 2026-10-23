#!/bin/sh
# Tests for binauth.sh and custombinauth.sh, run the way the router runs them:
# busybox ash with busybox applets only, plus a fake `date` (the day comes from
# FAKE_DAY) and a fake `logger` (writes to a file the test reads).
#
#   Linux / WSL:  sh openwrt/test-binauth.sh      (needs busybox: apt-get install -y busybox)
#   Windows:      wsl.exe -d Ubuntu-24.04 -u root -- sh /mnt/c/<repo>/openwrt/test-binauth.sh
#
# Exit 0 when every check passes.

HERE=$(cd "$(dirname "$0")" && pwd)
BUSYBOX=$(command -v busybox) || {
	echo "busybox not found (apt-get install -y busybox)"
	exit 2
}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

BIN=$WORK/bin
mkdir -p "$BIN"
"$BUSYBOX" --install -s "$BIN"
ln -sf "$BUSYBOX" "$BIN/busybox"
rm -f "$BIN/date" "$BIN/logger"
cat >"$BIN/date" <<'EOF'
#!/bin/sh
case "$1" in
	+%Y-%m-%d) printf '%s\n' "$FAKE_DAY" ;;
	*) exec busybox date "$@" ;;
esac
EOF
cat >"$BIN/logger" <<'EOF'
#!/bin/sh
# "logger -t TAG MESSAGE" -> "TAG MESSAGE", like a syslog line without its date.
tag=logger
if [ "$1" = "-t" ]; then tag=$2; shift 2; fi
printf '%s %s\n' "$tag" "$*" >>"$FAKE_LOG"
EOF
chmod 755 "$BIN/date" "$BIN/logger"

STATE=$WORK/state
CONF=$WORK/freewifi.conf
LOG=$WORK/syslog
: >"$LOG"
echo "FREE_INTERNET_SECONDS=120" >"$CONF"
DAY=2026-10-25

PASS=0
FAIL=0
check() { # name actual expected
	if [ "$2" = "$3" ]; then
		PASS=$((PASS + 1))
		echo "ok   $1"
	else
		FAIL=$((FAIL + 1))
		echo "FAIL $1: expected [$3], got [$2]"
	fi
}

# binauth.sh with a clean environment, as openNDS starts it. Sets OUT and RC.
run() {
	OUT=$(env -i PATH="$BIN" FAKE_DAY="$DAY" FAKE_LOG="$LOG" \
		FICHA_STATE_DIR="$STATE" FICHA_CONF="$CONF" \
		"$BUSYBOX" ash "$HERE/binauth.sh" "$@")
	RC=$?
}

# auth_client the way openNDS 10.3.1 calls it: MAC REDIR USERAGENT IP TOKEN CUSTOM.
ask() {
	run auth_client "$1" "http%3a%2f%2fconnectivitycheck.gstatic.com%2fgenerate_204" "Mozilla%2f5.0" 192.168.8.123 a1b2c3d4 bmE%3d
}

grants() { grep -c "^ficha-freewifi free_grant what=internet" "$LOG"; }

MAC1=a4:5e:60:d1:22:01
MAC2=a4:5e:60:d1:22:02
MAC3=0c:7a:15:9e:40:03
MAC4=0c:7a:15:9e:40:04
MAC5=0c:7a:15:9e:40:05

echo "== syntax"
"$BUSYBOX" ash -n "$HERE/binauth.sh"
check "binauth.sh parses under busybox ash" "$?" 0
"$BUSYBOX" ash -n "$HERE/custombinauth.sh"
check "custombinauth.sh parses under busybox ash" "$?" 0

echo "== first request of the day: allowed, 120 s"
ask "$MAC1"
check "first grant answer" "$OUT" "120 0 0 0 0"
check "first grant exit code" "$RC" 0
check "one free_grant logged" "$(grants)" 1
grep -q "^ficha-freewifi free_grant what=internet id=[0-9a-f]\{16\} seconds=120$" "$LOG"
check "log line: kind, hashed id, what, seconds" "$?" 0

echo "== the notices that follow a grant are allowed and change nothing"
before=$(find "$STATE" -type f | sort | xargs cat | md5sum)
run client_auth "$MAC1" 0 0 1761400000 1761400120 a1b2c3d4 bmE%3d
check "client_auth: exit 0" "$RC" 0
check "client_auth: no output" "$OUT" ""
for m in timeout_deauth idle_deauth client_deauth ndsctl_deauth shutdown_deauth download_quota_deauth upload_quota_deauth; do
	run "$m" "$MAC1" 1200 3400 1761400000 1761400120 a1b2c3d4 bmE%3d
	check "$m: exit 0, no output" "$RC/$OUT" "0/"
done
after=$(find "$STATE" -type f | sort | xargs cat | md5sum)
check "notices leave the state as it was" "$after" "$before"

echo "== the same device again the same day: refused"
ask "$MAC1"
check "second request: no number (the deny every openNDS version reads)" "$OUT" ""
check "second request: exit 0 (9.8.0 and 10.3.1 would let a non-zero exit in)" "$RC" 0
grep -q "^ficha-freewifi free_refused what=internet id=[0-9a-f]\{16\} reason=used_today$" "$LOG"
check "refusal logged with the hashed id only" "$?" 0
ask "A4:5E:60:D1:22:01"
check "same device, upper case: refused" "$OUT" ""
ask "a4-5e-60-d1-22-01"
check "same device, dashes: refused" "$OUT" ""
run auth_client "$MAC1" "" "" "http%3a%2f%2fexample.com" "Mozilla" 192.168.8.123 a1b2c3d4 bmE%3d
check "same device, 9.x argument order: refused" "$OUT" ""

echo "== different devices are independent"
ask "$MAC2"
check "second device: allowed" "$OUT" "120 0 0 0 0"
run auth_client "$MAC3" "" "" "http%3a%2f%2fexample.com" "Mozilla" 192.168.8.124 b2c3d4e5 bmE%3d
check "third device, 9.x argument order: allowed" "$OUT" "120 0 0 0 0"
check "three grants logged" "$(grants)" 3
ask "$MAC2"
check "second device again: refused" "$OUT" ""

echo "== an operator's ndsctl auth is allowed and spends nothing"
run ndsctl_auth "$MAC4" 0 0 1761400000 1761400120 c3d4e5f6 bmE%3d
check "ndsctl_auth: exit 0, no output" "$RC/$OUT" "0/"
ask "$MAC4"
check "that device still has its free minutes" "$OUT" "120 0 0 0 0"

echo "== bad input and broken state are refused (fail closed)"
ask "not-a-mac"
check "malformed MAC: refused" "$RC/$OUT" "0/"
ask ""
check "empty MAC: refused" "$RC/$OUT" "0/"
ask "a4:5e:60:d1:22"
check "short MAC: refused" "$RC/$OUT" "0/"
run
check "no method: exit 1, no output" "$RC/$OUT" "1/"
SAVED_STATE=$STATE
STATE=$WORK/a-file
: >"$STATE"
ask "$MAC5"
check "state directory cannot be made: refused" "$RC/$OUT" "0/"
STATE=$SAVED_STATE
SALT_FILE=$STATE/day-$DAY/salt
cp "$SALT_FILE" "$WORK/salt.bak"
echo "not-a-salt" >"$SALT_FILE"
ask "$MAC5"
check "corrupt salt: refused" "$RC/$OUT" "0/"
cp "$WORK/salt.bak" "$SALT_FILE"

echo "== the allowance comes from freewifi.conf"
echo "FREE_INTERNET_SECONDS=0" >"$CONF"
ask "$MAC5"
check "FREE_INTERNET_SECONDS=0: no free internet" "$OUT" ""
echo "FREE_INTERNET_SECONDS=two minutes" >"$CONF"
ask "$MAC5"
check "not a number: no free internet" "$OUT" ""
echo "FREE_INTERNET_SECONDS='060'" >"$CONF"
ask "$MAC5"
check "quoted, leading zero (not octal): 60 s" "$OUT" "60 0 0 0 0"
echo "FREE_INTERNET_SECONDS=120" >"$CONF"
ask "$MAC5"
check "allowance raised the same day: only the 60 s left" "$OUT" "60 0 0 0 0"
ask "$MAC5"
check "then refused" "$OUT" ""
rm -f "$CONF"
ask "0c:7a:15:9e:40:06"
check "no freewifi.conf: the default 120 s" "$OUT" "120 0 0 0 0"
echo "FREE_INTERNET_SECONDS=120" >"$CONF"
DUSED=$(find "$STATE/day-$DAY/used" -type f | wc -l)
check "used counts on day 1 (devices 1, 2, 3, 4, 5, 6)" "$DUSED" 6
check "a stored count holds the whole window" "$(cat "$(find "$STATE/day-$DAY/used" -type f | head -n 1)")" 120

echo "== no raw MAC anywhere, hashes only"
FILES=$WORK/day1-files
(cd "$STATE" && find . | sort) >"$FILES"
HIT=0
for m in "$MAC1" "$MAC2" "$MAC3" "$MAC4" "$MAC5" 0c:7a:15:9e:40:06; do
	up=$(printf '%s' "$m" | tr 'a-f' 'A-F')
	bare=$(printf '%s' "$m" | tr -d ':')
	dash=$(printf '%s' "$m" | tr ':' '-')
	for form in "$m" "$up" "$bare" "$dash"; do
		grep -rqiF "$form" "$STATE" "$LOG" && HIT=$((HIT + 1))
		grep -qiF "$form" "$FILES" && HIT=$((HIT + 1))
	done
done
check "no MAC (any spelling) in /tmp files, file names or the log" "$HIT" 0
grep -q "192\.168\." "$LOG"
check "no IP address in the log" "$?" 1
ls "$STATE/day-$DAY/used" | grep -qv '^[0-9a-f]\{64\}$'
check "count files are named by 64-hex hashes only" "$?" 1
check "state directory is private (700)" "$(stat -c %a "$STATE")" 700
check "salt is private (600)" "$(stat -c %a "$STATE/day-$DAY/salt")" 600
SALT1=$(cat "$STATE/day-$DAY/salt")
NAMES1=$(ls "$STATE/day-$DAY/used" | sort)

echo "== the next day: a new allowance, a new salt, yesterday deleted"
DAY=2026-10-26
ask "$MAC1"
check "first device on day 2: allowed" "$OUT" "120 0 0 0 0"
check "day 1 directory deleted" "$(ls "$STATE")" "day-$DAY"
SALT2=$(cat "$STATE/day-$DAY/salt")
[ "$SALT1" != "$SALT2" ]
check "a new salt" "$?" 0
NAMES2=$(ls "$STATE/day-$DAY/used")
echo "$NAMES1" | grep -qxF "$NAMES2"
check "the device's hash differs from day 1's (no link across days)" "$?" 1
ask "$MAC1"
check "first device again on day 2: refused" "$OUT" ""

echo "== the midnight cron job"
run rotate
check "rotate on the same day: exit 0, no output" "$RC/$OUT" "0/"
check "rotate on the same day keeps today" "$(ls "$STATE")" "day-$DAY"
DAY=2026-10-27
run rotate
check "rotate after midnight: exit 0, no output" "$RC/$OUT" "0/"
check "rotate after midnight deletes yesterday and its salt" "$(ls -A "$STATE")" ""
ask "$MAC1"
check "first device on day 3: allowed" "$OUT" "120 0 0 0 0"

echo "== openNDS 11: custombinauth.sh sourced by binauth_log.sh"
# What binauth_log.sh does around the sourced file: defaults, ". custombinauth", then echo/exit.
cat >"$WORK/binauth_log_like.sh" <<'EOF'
sessiontimeout=0
upload_rate=0
download_rate=0
upload_quota=0
download_quota=0
exitlevel=0
. "$CUSTOMBINAUTH"
echo "$sessiontimeout $upload_rate $download_rate $upload_quota $download_quota"
exit $exitlevel
EOF
v11() {
	OUT=$(env -i PATH="$BIN" FAKE_DAY="$DAY" FAKE_LOG="$LOG" \
		FICHA_STATE_DIR="$STATE" FICHA_CONF="$CONF" \
		FICHA_BINAUTH="$HERE/binauth.sh" CUSTOMBINAUTH="$HERE/custombinauth.sh" \
		"$BUSYBOX" ash "$WORK/binauth_log_like.sh" "$@")
	RC=$?
}
v11 auth_client 0c:7a:15:9e:40:07 "http%3a%2f%2fexample.com" "Mozilla" 192.168.8.125 d4e5f6a7 bmE%3d
check "v11 new device: exit 0 with 120 s" "$RC/$OUT" "0/120 0 0 0 0"
v11 auth_client 0c:7a:15:9e:40:07 "http%3a%2f%2fexample.com" "Mozilla" 192.168.8.125 d4e5f6a7 bmE%3d
check "v11 same device again: exitlevel 1 (v11 refuses on it)" "$RC" 1
v11 client_auth 0c:7a:15:9e:40:07 0 0 1761400000 1761400120 d4e5f6a7 bmE%3d
check "v11 client_auth notice: allowed, untouched" "$RC/$OUT" "0/0 0 0 0 0"

if command -v shellcheck >/dev/null 2>&1; then
	echo "== shellcheck"
	shellcheck -s sh "$HERE/binauth.sh" "$HERE/custombinauth.sh"
	check "shellcheck -s sh: no findings" "$?" 0
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
