#!/bin/sh
# Ficha: make a GL.iNet (OpenWrt) router the station's Wi-Fi, with free emergency minutes.
#
# openNDS sends every new phone to the station's portal (FAS level 0, on the
# station laptop), lets every phone reach the payment hosts without spending
# anything (walled garden, port 443), and opens the internet through the
# sign-in for FREE_INTERNET_SECONDS per device per day (binauth.sh, decided
# here on the router). That is a courtesy limit, not a hard one: the walled
# garden opens addresses that Vercel and Cloudflare share with other sites,
# to every phone, and DNS is open (README.md, "The 2 minutes are a courtesy").
# The station laptop is trusted: it is never held at the portal.
# No secret in this file, and none goes to the station.
#
# On the router, as root, with binauth.sh and custombinauth.sh in the same folder:
#   sh setup.sh            apply. Idempotent: run it again after changing a variable.
#   sh setup.sh --check    show what is set, change nothing
#   sh setup.sh --remove   portal off, and undo this script's changes
# Variables come from the environment or from the defaults below:
#   STATION_MAC=aa:bb:cc:dd:ee:ff sh setup.sh

# ---- variables ---------------------------------------------------------------
# The station laptop: its MAC on THIS network (Windows: ipconfig /all, the
# adapter connected to the router; a Wi-Fi "random hardware address" counts as
# its MAC here), the fixed IP the router gives it, and the station's PORT (the
# station runs with HOST=0.0.0.0 and WIFI_PORTAL=opennds).
STATION_MAC=${STATION_MAC:-}
STATION_IP=${STATION_IP:-192.168.8.20}
PORT=${PORT:-8000}
FASPATH=${FASPATH:-/portal}
GATEWAYNAME=${GATEWAYNAME:-Ficha}
# Wi-Fi name of the router's main (LAN) network; empty = keep it. The Wi-Fi
# password is not handled here: keep the router's (the station's WIFI_PASSWORD
# must match) or set WIFI_OPEN=1 for an open network (station: WIFI_SECURITY=nopass).
SSID=${SSID:-}
WIFI_OPEN=${WIFI_OPEN:-0}
# Free internet per device per day, in seconds (0 = none: payments only).
FREE_INTERNET_SECONDS=${FREE_INTERNET_SECONDS:-120}
# How often openNDS checks for ended sessions: a free window ends at most this late.
CHECKINTERVAL=${CHECKINTERVAL:-10}
# openNDS syslog: 0 = errors only (it logs client MACs from 1 up); 2 while debugging.
DEBUGLEVEL=${DEBUGLEVEL:-0}
# Hosts every phone reaches without spending its free minutes, for paying with
# Ficha (openwrt/README.md says where the app uses each one). Port 443 only.
WALLED_GARDEN=${WALLED_GARDEN:-"ficha-stellar.vercel.app horizon-testnet.stellar.org soroban-testnet.stellar.org friendbot.stellar.org testanchor.stellar.org"}
WALLED_GARDEN_PORTS=${WALLED_GARDEN_PORTS:-443}
LAN_DEVICE=${LAN_DEVICE:-br-lan}
# ------------------------------------------------------------------------------

# FICHA_ROOT is for openwrt/test-setup.sh only (a fake router's root); empty on a router.
ROOT=${FICHA_ROOT:-}
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=/usr/lib/ficha
ETC=/etc/ficha
BACKUP=$ETC/backup
CRON_LINE="0 0 * * * $LIB/binauth.sh rotate"
CRONTAB=$ROOT/etc/crontabs/root
S=opennds.setup

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
# Said after a setup and by --check: what the free minutes are, and are not.
courtesy_note() {
	say "NOTE: the free internet is a courtesy limit, not a hard one: the walled garden opens addresses that Vercel and Cloudflare share with other sites, to every phone, with no sign-in, and DNS is open. Never call it enforced (README.md, \"The 2 minutes are a courtesy\")."
}
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

# uci set, only when the value differs. CHANGED_<config>=1 when it did.
set_opt() { # config.section.option value
	if [ "$(uci -q get "$1")" != "$2" ]; then
		uci set "$1=$2" || die "uci set $1 failed"
		eval "CHANGED_${1%%.*}=1"
	fi
}

del_opt() { # config.section.option
	if uci -q get "$1" >/dev/null; then
		uci -q delete "$1"
		eval "CHANGED_${1%%.*}=1"
	fi
}

# A list that must hold exactly the one value $2.
set_list() { # config.section.option value
	if [ "$(uci -q get "$1")" != "$2" ]; then
		uci -q delete "$1"
		uci add_list "$1=$2" || die "uci add_list $1 failed"
		eval "CHANGED_${1%%.*}=1"
	fi
}

valid_ipv4() {
	case $1 in
		*[!0-9.]* | *..* | .* | *.) return 1 ;;
	esac
	# shellcheck disable=SC2046
	set -- $(printf '%s' "$1" | tr '.' ' ')
	[ $# -eq 4 ] || return 1
	for _o in "$@"; do
		[ "${#_o}" -le 3 ] && [ "$_o" -le 255 ] || return 1
	done
}

valid_mac() {
	case $1 in
		[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) return 0 ;;
	esac
	return 1
}

is_number() {
	case $1 in
		'' | *[!0-9]*) return 1 ;;
	esac
}

# $1 is a whole number from $2 to $3.
in_range() {
	is_number "$1" && [ "${#1}" -le 9 ] && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

check_router() {
	[ -f "$ROOT/etc/openwrt_release" ] || die "this is not an OpenWrt router (no /etc/openwrt_release)"
	command -v uci >/dev/null 2>&1 || die "uci not found"
	[ "$(id -u)" = 0 ] || die "run as root"
}

check_variables() {
	[ -n "$STATION_MAC" ] || die "set STATION_MAC, the station laptop's MAC on this network: STATION_MAC=aa:bb:cc:dd:ee:ff sh setup.sh"
	STATION_MAC=$(printf '%s' "$STATION_MAC" | tr 'A-F-' 'a-f:')
	valid_mac "$STATION_MAC" || die "STATION_MAC=$STATION_MAC is not a MAC address (aa:bb:cc:dd:ee:ff)"
	valid_ipv4 "$STATION_IP" || die "STATION_IP=$STATION_IP is not an IPv4 address"
	in_range "$PORT" 1 65535 || die "PORT=$PORT is not a port number"
	case $FASPATH in
		/*) ;;
		*) die "FASPATH=$FASPATH must start with /" ;;
	esac
	case $FASPATH$GATEWAYNAME$SSID$WALLED_GARDEN in
		*\'* | *\"* | *\\*) die "no quotes or backslashes in FASPATH, GATEWAYNAME, SSID or WALLED_GARDEN" ;;
	esac
	in_range "$FREE_INTERNET_SECONDS" 0 86400 || die "FREE_INTERNET_SECONDS=$FREE_INTERNET_SECONDS: use 0 to 86400"
	in_range "$CHECKINTERVAL" 1 3600 || die "CHECKINTERVAL=$CHECKINTERVAL: use 1 to 3600 seconds"
	case $DEBUGLEVEL in 0 | 1 | 2 | 3) ;; *) die "DEBUGLEVEL=$DEBUGLEVEL: use 0 to 3" ;; esac
	case $WIFI_OPEN in 0 | 1) ;; *) die "WIFI_OPEN=$WIFI_OPEN: use 0 or 1" ;; esac
	[ -n "$WALLED_GARDEN" ] || die "WALLED_GARDEN is empty: phones could not pay"
	[ "${#SSID}" -le 32 ] || die "SSID is longer than 32 bytes"

	lan_ip=$(uci -q get network.lan.ipaddr)
	lan_ip=${lan_ip%%/*}
	if [ -n "$lan_ip" ]; then
		[ "$lan_ip" != "$STATION_IP" ] || die "STATION_IP=$STATION_IP is the router's own address"
		[ "${lan_ip%.*}" = "${STATION_IP%.*}" ] ||
			warn "STATION_IP=$STATION_IP is not in the router's LAN ${lan_ip%.*}.0/24: phones will not reach the portal"
	fi
}

backup_once() {
	[ -d "$ROOT$BACKUP" ] && return 0
	mkdir -p "$ROOT$BACKUP" || die "cannot make $BACKUP"
	for f in opennds dhcp wireless; do
		[ -f "$ROOT/etc/config/$f" ] && cp -p "$ROOT/etc/config/$f" "$ROOT$BACKUP/$f"
	done
	[ -f "$CRONTAB" ] && cp -p "$CRONTAB" "$ROOT$BACKUP/crontab"
	say "Saved the router's configs as they were before Ficha: $BACKUP"
}

PKG_UPDATED=0
pkg() { # install PACKAGE
	if command -v apk >/dev/null 2>&1; then
		[ "$PKG_UPDATED" = 1 ] || { apk update || die "apk update failed: is the router online?"; }
		PKG_UPDATED=1
		apk add "$1"
	else
		[ "$PKG_UPDATED" = 1 ] || { opkg update || die "opkg update failed: is the router online?"; }
		PKG_UPDATED=1
		opkg install "$1"
	fi
}

packages() {
	if [ ! -x "$ROOT/usr/bin/opennds" ]; then
		say "Installing openNDS..."
		pkg opennds || die "could not install opennds"
	fi
	# The walled garden by name needs dnsmasq built with nftset (or ipset on OpenWrt 21.02).
	opts=$(dnsmasq --version 2>/dev/null | grep -m1 'Compile time options')
	case $opts in
		*" nftset"* | *" ipset"*) ;;
		*)
			say "Installing dnsmasq-full (the walled garden needs nftset/ipset)..."
			if command -v apk >/dev/null 2>&1; then
				pkg dnsmasq-full || die "could not install dnsmasq-full: apk del dnsmasq && apk add dnsmasq-full"
			else
				# Download first: removing dnsmasq stops the router's own DNS.
				[ "$PKG_UPDATED" = 1 ] || opkg update || die "opkg update failed: is the router online?"
				PKG_UPDATED=1
				(cd /tmp && rm -f dnsmasq-full_*.ipk && opkg download dnsmasq-full) || die "could not download dnsmasq-full"
				opkg remove dnsmasq
				opkg install /tmp/dnsmasq-full_*.ipk || die "could not install dnsmasq-full (/tmp/dnsmasq-full_*.ipk)"
				rm -f /tmp/dnsmasq-full_*.ipk
			fi
			opts=$(dnsmasq --version 2>/dev/null | grep -m1 'Compile time options')
			;;
	esac
	# iptables firewall (OpenWrt 21.02) with ipset-only dnsmasq: the ipset tool too.
	if ! command -v nft >/dev/null 2>&1 && ! command -v ipset >/dev/null 2>&1; then
		say "Installing ipset..."
		pkg ipset || die "could not install ipset"
	fi
}

install_files() {
	for f in binauth.sh custombinauth.sh; do
		[ -f "$HERE/$f" ] || die "$f not found beside setup.sh ($HERE)"
	done
	mkdir -p "$ROOT$LIB" "$ROOT$ETC" || die "cannot make $LIB or $ETC"
	for f in binauth.sh custombinauth.sh; do
		if ! cmp -s "$HERE/$f" "$ROOT$LIB/$f"; then
			if ! cp "$HERE/$f" "$ROOT$LIB/$f.tmp" || ! mv -f "$ROOT$LIB/$f.tmp" "$ROOT$LIB/$f"; then
				die "cannot install $LIB/$f"
			fi
			CHANGED_files=1
		fi
	done
	chmod 755 "$ROOT$LIB/binauth.sh"
	chmod 644 "$ROOT$LIB/custombinauth.sh"
	conf="FREE_INTERNET_SECONDS=$FREE_INTERNET_SECONDS"
	if [ "$(cat "$ROOT$ETC/freewifi.conf" 2>/dev/null)" != "$conf" ]; then
		printf '%s\n' "$conf" >"$ROOT$ETC/freewifi.conf" || die "cannot write $ETC/freewifi.conf"
		CHANGED_files=1
	fi
}

configure_opennds() {
	[ -f "$ROOT/etc/config/opennds" ] || : >"$ROOT/etc/config/opennds"
	# openNDS 11 wants the section named "setup"; 9 and 10 read the first one either way.
	if [ "$(uci -q get opennds.setup)" != opennds ]; then
		if [ "$(uci -q get 'opennds.@opennds[0]')" = opennds ]; then
			uci rename 'opennds.@opennds[0]=setup'
		else
			uci set opennds.setup=opennds
		fi
		CHANGED_opennds=1
	fi
	minutes=$((FREE_INTERNET_SECONDS / 60))
	[ "$minutes" -ge 1 ] || minutes=1
	set_opt "$S.enabled" 1
	set_opt "$S.gatewayinterface" "$LAN_DEVICE"
	set_opt "$S.gatewayname" "$GATEWAYNAME"
	# FAS level 0 on the station: no key, so the station holds no secret.
	set_opt "$S.fasport" "$PORT"
	set_opt "$S.fasremoteip" "$STATION_IP"
	del_opt "$S.fasremotefqdn"
	set_opt "$S.faspath" "$FASPATH"
	set_opt "$S.fas_secure_enabled" 0
	set_opt "$S.login_option_enabled" 0
	# No RFC 8910 portal URL by DHCP: its JSON omits authaction, so phones use the
	# classic probe and get the redirect that carries it.
	set_opt "$S.dhcp_default_url_enable" 0
	# The free window. binauth.sh gives the exact seconds; this is the fallback.
	set_opt "$S.sessiontimeout" "$minutes"
	set_opt "$S.checkinterval" "$CHECKINTERVAL"
	set_opt "$S.binauth" "$LIB/binauth.sh"
	set_opt "$S.custombinauth" "$LIB/custombinauth.sh"
	set_opt "$S.debuglevel" "$DEBUGLEVEL"
	set_list "$S.walledgarden_fqdn_list" "$WALLED_GARDEN"
	set_list "$S.walledgarden_port_list" "$WALLED_GARDEN_PORTS"
	# The station laptop goes straight out (Horizon, Soroban RPC, the registry).
	# A previous station's MAC (from this script's reservation) stops being trusted.
	old_mac=$(uci -q get dhcp.ficha_station.mac)
	if [ -n "$old_mac" ] && [ "$old_mac" != "$STATION_MAC" ] &&
		uci -q get "$S.trustedmac" | tr ' ' '\n' | grep -qxF "$old_mac"; then
		uci del_list "$S.trustedmac=$old_mac"
		CHANGED_opennds=1
	fi
	if ! uci -q get "$S.trustedmac" | tr ' ' '\n' | grep -qxF "$STATION_MAC"; then
		uci add_list "$S.trustedmac=$STATION_MAC" || die "uci add_list trustedmac failed"
		CHANGED_opennds=1
	fi
	[ "${CHANGED_opennds:-0}" = 1 ] && uci commit opennds
}

configure_dhcp() {
	if [ "$(uci -q get dhcp.ficha_station)" != host ]; then
		uci set dhcp.ficha_station=host
		CHANGED_dhcp=1
	fi
	set_opt dhcp.ficha_station.name ficha-station
	set_opt dhcp.ficha_station.mac "$STATION_MAC"
	set_opt dhcp.ficha_station.ip "$STATION_IP"
	[ "${CHANGED_dhcp:-0}" = 1 ] && uci commit dhcp
	others=$(uci show dhcp 2>/dev/null | grep -v '^dhcp\.ficha_station\.' |
		grep -iE "\.(mac='$STATION_MAC'|ip='$STATION_IP')$")
	[ -z "$others" ] || warn "another DHCP reservation uses the station's MAC or IP: $others"
}

lan_aps() {
	uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.=]*\)=wifi-iface$/\1/p' | while read -r s; do
		[ "$(uci -q get "wireless.$s.mode")" = ap ] || continue
		uci -q get "wireless.$s.network" | tr ' ' '\n' | grep -qx lan && echo "$s"
	done
}

configure_wifi() {
	aps=$(lan_aps)
	[ -n "$aps" ] || {
		warn "no Wi-Fi access point on the LAN found: phones must join the LAN network"
		return 0
	}
	for s in $aps; do
		[ -n "$SSID" ] && set_opt "wireless.$s.ssid" "$SSID"
		if [ "$WIFI_OPEN" = 1 ]; then
			set_opt "wireless.$s.encryption" none
			del_opt "wireless.$s.key"
		fi
		[ "$(uci -q get "wireless.$s.isolate")" = 1 ] &&
			warn "wireless.$s has client isolation on: the station's Wi-Fi meter (ADB) cannot reach the phone"
		[ "$(uci -q get "wireless.$s.disabled")" = 1 ] && warn "wireless.$s is disabled"
	done
	[ "${CHANGED_wireless:-0}" = 1 ] && uci commit wireless
}

configure_cron() {
	mkdir -p "$(dirname "$CRONTAB")"
	if ! grep -qxF "$CRON_LINE" "$CRONTAB" 2>/dev/null; then
		printf '%s\n' "$CRON_LINE" >>"$CRONTAB"
		CHANGED_cron=1
	fi
	"$ROOT/etc/init.d/cron" enable
	[ "${CHANGED_cron:-0}" = 1 ] && "$ROOT/etc/init.d/cron" restart
}

check_ipv6() {
	ra=$(uci -q get dhcp.lan.ra)
	if ip -6 addr show dev "$LAN_DEVICE" scope global 2>/dev/null | grep -q inet6 ||
		[ "$ra" = server ] || [ "$ra" = relay ]; then
		warn "IPv6 is on for the LAN. openNDS filters IPv4 (10.x also stops the interface wan6, no other uplink): a phone could go out over IPv6 without the portal. GL.iNet admin: NETWORK > IPv6 > off."
	fi
}

restart_services() {
	"$ROOT/etc/init.d/opennds" enable
	if [ "${CHANGED_opennds:-0}${CHANGED_files:-0}" != 00 ] || ! "$ROOT/etc/init.d/opennds" running >/dev/null 2>&1; then
		say "Restarting openNDS..."
		"$ROOT/etc/init.d/opennds" restart
	fi
	if [ "${CHANGED_dhcp:-0}" = 1 ]; then
		say "Restarting dnsmasq (the station's reservation)..."
		"$ROOT/etc/init.d/dnsmasq" restart
	fi
	if [ "${CHANGED_wireless:-0}" = 1 ]; then
		say "Reloading Wi-Fi: a connection over Wi-Fi drops now; join \"${SSID:-the network}\" again."
		wifi reload
	fi
}

verify() {
	ok=0
	tries=0
	while [ "$tries" -lt 10 ]; do
		ndsctl status >/dev/null 2>&1 && ok=1 && break
		tries=$((tries + 1))
		sleep 2
	done
	if [ "$ok" = 1 ]; then say "ok   openNDS is running"; else warn "openNDS does not answer: logread -e opennds"; fi
	url="http://$STATION_IP:$PORT$FASPATH"
	# Any HTTP answer counts (busybox wget, uclient-fetch and GNU wget word errors differently).
	if out=$(wget -T 5 -O /dev/null "$url" 2>&1) ||
		printf '%s' "$out" | grep -qiE '(HTTP/1\.[01]|error:?) [1-5][0-9][0-9]'; then
		say "ok   the station's portal answers: $url"
	else
		warn "the station's portal does not answer at $url yet (station running with HOST=0.0.0.0 and WIFI_PORTAL=opennds? Windows firewall allowing TCP $PORT?)"
	fi
}

show() {
	say "openNDS (/etc/config/opennds):"
	uci -q show opennds.setup || uci -q show opennds || say "  (none)"
	say "Station reservation:"
	uci -q show dhcp.ficha_station || say "  (none)"
	say "Ficha files:"
	for f in "$LIB/binauth.sh" "$LIB/custombinauth.sh" "$ETC/freewifi.conf"; do
		if [ -f "$ROOT$f" ]; then say "  $f"; else say "  $f MISSING"; fi
	done
	[ -f "$ROOT$ETC/freewifi.conf" ] && say "  $(cat "$ROOT$ETC/freewifi.conf")"
	if grep -qxF "$CRON_LINE" "$CRONTAB" 2>/dev/null; then say "Midnight cron job: present"; else say "Midnight cron job: MISSING"; fi
	for d in /tmp/ficha-freewifi/day-*; do
		[ -d "$d/used" ] || continue
		say "Free internet given on ${d##*/day-}: $(find "$d/used" -type f | wc -l) device(s)"
	done
	say "openNDS status:"
	ndsctl status 2>/dev/null | sed -n '1,25p' || say "  not running"
	courtesy_note
}

remove() {
	say "Turning the Ficha portal off..."
	"$ROOT/etc/init.d/opennds" stop
	"$ROOT/etc/init.d/opennds" disable
	if [ -f "$ROOT$BACKUP/opennds" ]; then
		cp -p "$ROOT$BACKUP/opennds" "$ROOT/etc/config/opennds"
		say "Restored /etc/config/opennds from $BACKUP"
	elif [ "$(uci -q get opennds.setup)" = opennds ]; then
		uci set opennds.setup.enabled=0
		uci commit opennds
	fi
	if [ "$(uci -q get dhcp.ficha_station)" = host ]; then
		uci delete dhcp.ficha_station
		uci commit dhcp
		"$ROOT/etc/init.d/dnsmasq" restart
	fi
	if [ -f "$CRONTAB" ] && grep -qxF "$CRON_LINE" "$CRONTAB"; then
		grep -vxF "$CRON_LINE" "$CRONTAB" >"$CRONTAB.tmp"
		mv -f "$CRONTAB.tmp" "$CRONTAB"
		"$ROOT/etc/init.d/cron" restart
	fi
	rm -rf "$ROOT$LIB" "$ROOT$ETC/freewifi.conf" /tmp/ficha-freewifi
	say "Done: the router is a plain router again (packages stay installed)."
	if [ -f "$ROOT$BACKUP/wireless" ] && ! cmp -s "$ROOT$BACKUP/wireless" "$ROOT/etc/config/wireless"; then
		say "The Wi-Fi settings differ from before Ficha. To restore them (drops Wi-Fi connections):"
		say "  cp $BACKUP/wireless /etc/config/wireless && wifi reload"
	fi
}

case $1 in
	--check)
		show
		;;
	--remove)
		check_router
		remove
		;;
	'')
		check_router
		check_variables
		backup_once
		packages
		install_files
		configure_opennds
		configure_dhcp
		configure_wifi
		configure_cron
		check_ipv6
		restart_services
		verify
		say ""
		say "Ficha portal: http://$STATION_IP:$PORT$FASPATH  (gateway \"$GATEWAYNAME\", free internet ${FREE_INTERNET_SECONDS}s per device per day)"
		say "Walled garden ($WALLED_GARDEN_PORTS): $WALLED_GARDEN"
		say "Station laptop $STATION_MAC: fixed IP $STATION_IP, trusted (no portal)."
		courtesy_note
		;;
	*)
		die "usage: sh setup.sh [--check | --remove]"
		;;
esac
