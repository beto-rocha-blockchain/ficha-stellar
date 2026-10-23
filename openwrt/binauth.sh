#!/bin/sh
# Ficha free emergency internet: the openNDS BinAuth script of the station's router.
#
# Gives each device FREE_INTERNET_SECONDS of free internet per day through
# openNDS's sign-in, decided HERE, on the router, so a phone that calls the
# gateway's auth URL itself (skipping the station's portal) still cannot get
# more that way. A courtesy limit, not a hard one: the walled garden
# (setup.sh) opens addresses shared with other sites to every phone, with no
# sign-in (README.md, "The 2 minutes are a courtesy"). The station holds no
# secret of the router's; it only sends the phone to the auth URL.
#
# The device is the Wi-Fi MAC address openNDS reports. It is never stored: this
# script keeps only sha256(salt|mac), where the salt is 256 random bits made on
# the day's first request, kept in RAM (/tmp) for that day only and deleted when
# the day changes (here, or by the midnight cron job). So one day's hashes cannot
# be linked to another day's, nor turned back into a MAC once the salt is gone.
# The log line says only that a free grant happened: no MAC, no IP.
#
# One window per device per day: a grant is charged in full when it is given
# and is not paused if the phone leaves early. The total can never pass
# FREE_INTERNET_SECONDS. The day is the router's local date (a new allowance at
# local midnight); a router reboot empties /tmp and so starts a new day too.
#
# Installed by setup.sh:
#   /usr/lib/ficha/binauth.sh         openNDS 9, 10: option binauth '/usr/lib/ficha/binauth.sh'
#   /usr/lib/ficha/custombinauth.sh   openNDS 11+:   option custombinauth (calls this script)
#   /etc/ficha/freewifi.conf          FREE_INTERNET_SECONDS=120 (read as data, never run)
#   crontab: 0 0 * * * /usr/lib/ficha/binauth.sh rotate
#
# openNDS calling convention, checked in the openNDS sources (9.8.0, 10.3.1, 11.0.0):
#   auth_client MAC REDIR USERAGENT IP TOKEN CUSTOM
#       (older docs: MAC USERNAME PASSWORD REDIR USERAGENT IP TOKEN CUSTOM)
#       The decision: a client opened the gateway's /opennds_auth/?tok=...&redir=...
#   client_auth | ndsctl_auth | preemptive_auth  MAC IN OUT START END TOKEN CUSTOM
#       Notices after a grant this script gave, or an operator's "ndsctl auth":
#       always allowed (openNDS 11 refuses the client on a non-zero exit here).
#   timeout_deauth | idle_deauth | client_deauth | ndsctl_deauth | ...  same arguments
#       Notices: nothing to do.
#   rotate   (Ficha's own, from cron) delete every day's data but today's.
# Only $1 and $2 are read, so the argument differences between versions do not matter.
#
# The answer to auth_client, the one form every version reads the same way:
#   allow: print "SECONDS 0 0 0 0" and exit 0. SECONDS is the session length in
#          seconds; then upload rate, download rate, upload quota, download quota
#          (0 = the config's).
#   deny:  print NOTHING and exit 0. openNDS 9.8.0 and 10.3.1 IGNORE a non-zero
#          exit here (do_binauth returns 0, "script failed to execute", and the
#          client is let in with the default session); they refuse only when the
#          script prints no number. 11.0.0 refuses on both.
# Anything else on stdout would change the answer: every helper below keeps quiet.

umask 077

STATE_DIR=${FICHA_STATE_DIR:-/tmp/ficha-freewifi}
CONF=${FICHA_CONF:-/etc/ficha/freewifi.conf}
TAG=ficha-freewifi

log() {
	logger -t "$TAG" "$*" >/dev/null 2>&1
}

# A decimal number without leading zeros (ash reads 0120 as octal), or "" if $1 is not one.
decimal() {
	case $1 in
		'' | *[!0-9]*) return 0 ;;
	esac
	_n=$1
	while [ "${#_n}" -gt 1 ] && [ "${_n#0}" != "$_n" ]; do _n=${_n#0}; done
	[ "${#_n}" -le 9 ] && printf '%s' "$_n"
}

# FREE_INTERNET_SECONDS from the config file. No file: 120, the design value.
# Anything that is not a number: 0, no free internet (fail closed).
free_seconds() {
	_v=120
	if [ -e "$CONF" ]; then
		_v=$(sed -n 's/^[[:space:]]*FREE_INTERNET_SECONDS=//p' "$CONF" 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")
	fi
	_v=$(decimal "$_v")
	printf '%s' "${_v:-0}"
}

today() {
	_d=$(date +%Y-%m-%d 2>/dev/null)
	case $_d in
		[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) printf '%s' "$_d" ;;
	esac
}

is_hex64() {
	case $1 in
		'' | *[!0-9a-f]*) return 1 ;;
	esac
	[ "${#1}" -eq 64 ]
}

# Delete every day's directory but day $1's: its salt and its counts go with it.
drop_other_days() {
	for _d in "$STATE_DIR"/day-*; do
		[ -e "$_d" ] || continue
		[ "$_d" = "$STATE_DIR/day-$1" ] || rm -rf "$_d" 2>/dev/null
	done
}

# Day $1's directory, with its salt (made on the day's first request) in $SALT.
open_day() {
	mkdir -p "$STATE_DIR" 2>/dev/null && chmod 700 "$STATE_DIR" 2>/dev/null || return 1
	drop_other_days "$1"
	DAY_DIR=$STATE_DIR/day-$1
	mkdir -p "$DAY_DIR/used" 2>/dev/null || return 1
	if [ ! -s "$DAY_DIR/salt" ]; then
		dd if=/dev/urandom bs=32 count=1 2>/dev/null | sha256sum 2>/dev/null | cut -c1-64 >"$DAY_DIR/salt.tmp" 2>/dev/null &&
			mv -f "$DAY_DIR/salt.tmp" "$DAY_DIR/salt" 2>/dev/null || return 1
	fi
	SALT=$(cat "$DAY_DIR/salt" 2>/dev/null)
	is_hex64 "$SALT"
}

# The auth_client decision for MAC $1: sets GRANT to the seconds to give, or leaves it empty.
decide() {
	quota=$(free_seconds)
	if [ "$quota" -le 0 ]; then
		log "free_refused what=internet reason=off"
		return
	fi
	mac=$(printf '%s' "$1" | tr 'A-F-' 'a-f:')
	case $mac in
		[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
		*)
			log "free_refused what=internet reason=bad_device"
			return
			;;
	esac
	day=$(today)
	if [ -z "$day" ] || ! open_day "$day"; then
		log "free_error what=internet reason=state"
		return
	fi
	id=$(printf '%s|%s' "$SALT" "$mac" | sha256sum 2>/dev/null | cut -c1-64)
	mac=
	if ! is_hex64 "$id"; then
		log "free_error what=internet reason=hash"
		return
	fi
	short=$(printf '%s' "$id" | cut -c1-16)
	used=0
	if [ -e "$DAY_DIR/used/$id" ]; then
		# Unreadable count: spent (fail closed).
		used=$(decimal "$(cat "$DAY_DIR/used/$id" 2>/dev/null)")
		used=${used:-$quota}
	fi
	left=$((quota - used))
	if [ "$left" -le 0 ]; then
		log "free_refused what=internet id=$short reason=used_today"
		return
	fi
	# Charge the whole window now, before saying yes.
	if ! { printf '%s\n' "$quota" >"$DAY_DIR/used/$id.tmp" && mv -f "$DAY_DIR/used/$id.tmp" "$DAY_DIR/used/$id"; } 2>/dev/null; then
		log "free_error what=internet reason=state"
		return
	fi
	log "free_grant what=internet id=$short seconds=$left"
	GRANT=$left
}

case $1 in
	'')
		exit 1
		;;
	auth_client)
		GRANT=
		decide "$2"
		[ -n "$GRANT" ] && printf '%s 0 0 0 0\n' "$GRANT"
		exit 0
		;;
	rotate)
		day=$(today)
		[ -n "$day" ] && [ -d "$STATE_DIR" ] && drop_other_days "$day"
		exit 0
		;;
	*)
		# client_auth, ndsctl_auth, preemptive_auth and every *_deauth: notices.
		exit 0
		;;
esac
