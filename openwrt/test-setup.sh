#!/bin/sh
# Tests for setup.sh on a fake router: busybox ash and applets, a small fake
# `uci` (changes are staged until `uci commit`, like the real one), and stubs
# for opkg, dnsmasq, ndsctl, wget, wifi and the init scripts that only log.
# It checks what setup.sh writes, that a second run changes nothing, and that
# --remove gives the router back as it was. It cannot check openNDS itself:
# that is the README's checklist on the real router.
#
#   Linux / WSL:  sh openwrt/test-setup.sh      (needs busybox: apt-get install -y busybox)
#
# Exit 0 when every check passes.

HERE=$(cd "$(dirname "$0")" && pwd)
BUSYBOX=$(command -v busybox) || {
	echo "busybox not found (apt-get install -y busybox)"
	exit 2
}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
R=$WORK/root
BIN=$WORK/bin
CALLS=$WORK/calls
mkdir -p "$BIN" "$R/etc/config" "$R/etc/init.d" "$R/etc/crontabs" "$R/usr/bin" "$R/tmp"
"$BUSYBOX" --install -s "$BIN"
ln -sf "$BUSYBOX" "$BIN/busybox"
: >"$CALLS"

# ---- the fake uci --------------------------------------------------------------
# Storage, one file per config: "S name type", "O name option value", "L name option value".
rm -f "$BIN/uci"
cat >"$BIN/uci" <<'EOF'
#!/bin/sh
q=0
if [ "$1" = "-q" ]; then q=1; shift; fi
cmd=$1
arg=$2
CONF=$FICHA_ROOT/etc/config
STAGE=$FICHA_ROOT/tmp/.uci
mkdir -p "$STAGE"
fail() { [ "$q" = 1 ] || echo "uci: $1" >&2; exit 1; }
file() { if [ -f "$STAGE/$1" ]; then echo "$STAGE/$1"; else echo "$CONF/$1"; fi; }
stage() { [ -f "$STAGE/$1" ] || { [ -f "$CONF/$1" ] || fail "config not found"; cp "$CONF/$1" "$STAGE/$1"; }; }
rewrite() { awk "$@" "$F" >"$F.new" && mv "$F.new" "$F"; }

lhs=${arg%%=*}
has_val=0
case $arg in *=*) has_val=1; val=${arg#*=} ;; esac
c=${lhs%%.*}
rest=
s=
o=
case $lhs in *.*) rest=${lhs#*.} ;; esac
s=${rest%%.*}
case $rest in *.*) o=${rest#*.} ;; esac

if [ "$cmd" = commit ]; then
	for f in "$STAGE"/*; do
		[ -f "$f" ] || continue
		n=${f##*/}
		if [ -z "$arg" ] || [ "$arg" = "$n" ]; then mv "$f" "$CONF/$n"; fi
	done
	exit 0
fi
[ -n "$c" ] || fail "no config"
if [ "$cmd" != get ] && [ "$cmd" != show ]; then stage "$c"; fi
F=$(file "$c")
[ -f "$F" ] || fail "config not found"

# @type[N] -> the section's name
case $s in
	@*)
		t=${s#@}; t=${t%%\[*}; i=${s#*\[}; i=${i%\]}
		s=$(awk -v t="$t" -v i="$i" '$1=="S" && $3==t { if (n==i) { print $2; exit } n++ }' "$F")
		[ -n "$s" ] || fail "Entry not found"
		;;
esac
exists() { awk -v s="$s" '$1=="S" && $2==s {f=1} END {exit !f}' "$F"; }

case $cmd in
	get)
		[ -n "$s" ] || fail "Entry not found"
		if [ -z "$o" ]; then
			awk -v s="$s" '$1=="S" && $2==s {print $3; f=1} END {exit !f}' "$F" || fail "Entry not found"
		else
			awk -v s="$s" -v o="$o" '
				($1=="O" || $1=="L") && $2==s && $3==o { v=$0; sub(/^[OL] [^ ]+ [^ ]+ /, "", v); out = (n++ ? out " " : "") v }
				END { if (!n) exit 1; print out }' "$F" || fail "Entry not found"
		fi
		;;
	set)
		[ "$has_val" = 1 ] || fail "no value"
		if [ -z "$o" ]; then
			if exists; then rewrite -v s="$s" -v t="$val" '$1=="S" && $2==s {$3=t} {print}'
			else echo "S $s $val" >>"$F"; fi
		else
			exists || fail "Entry not found"
			rewrite -v s="$s" -v o="$o" '!(($1=="O" || $1=="L") && $2==s && $3==o)'
			echo "O $s $o $val" >>"$F"
		fi
		;;
	add_list)
		exists || fail "Entry not found"
		rewrite -v s="$s" -v o="$o" '!($1=="O" && $2==s && $3==o)'
		echo "L $s $o $val" >>"$F"
		;;
	del_list)
		awk -v s="$s" -v o="$o" -v v="$val" '$1=="L" && $2==s && $3==o { x=$0; sub(/^L [^ ]+ [^ ]+ /, "", x); if (x==v) f=1 } END {exit !f}' "$F" || fail "Entry not found"
		rewrite -v s="$s" -v o="$o" -v v="$val" '{ x=$0; sub(/^L [^ ]+ [^ ]+ /, "", x) } !($1=="L" && $2==s && $3==o && x==v)'
		;;
	delete)
		exists || fail "Entry not found"
		if [ -z "$o" ]; then
			rewrite -v s="$s" '$2!=s'
		else
			awk -v s="$s" -v o="$o" '($1=="O" || $1=="L") && $2==s && $3==o {f=1} END {exit !f}' "$F" || fail "Entry not found"
			rewrite -v s="$s" -v o="$o" '!(($1=="O" || $1=="L") && $2==s && $3==o)'
		fi
		;;
	rename)
		exists || fail "Entry not found"
		rewrite -v s="$s" -v n="$val" '$2==s {$2=n} {print}'
		;;
	show)
		awk -v c="$c" -v want="$s" '
			$1=="S" && (want=="" || $2==want) { order[++k]=$2; type[$2]=$3 }
			$1=="O" || $1=="L" { v=$0; sub(/^[OL] [^ ]+ [^ ]+ /, "", v); key=$2 "." $3
				if (!(key in val)) { okeys[$2]=okeys[$2] " " $3; val[key]="'\''" v "'\''" }
				else val[key]=val[key] " '\''" v "'\''" }
			END { for (j=1; j<=k; j++) { n=order[j]; print c "." n "=" type[n]
				m=split(okeys[n], ks, " "); for (x=1; x<=m; x++) print c "." n "." ks[x] "=" val[n "." ks[x]] } }' "$F"
		;;
	*)
		fail "unsupported command $cmd"
		;;
esac
EOF

chmod 755 "$BIN/uci"

# ---- the other stubs: they log to $CALLS ------------------------------------------
stub() { # name body
	rm -f "$BIN/$1"
	printf '#!/bin/sh\n%s\n' "$2" >"$BIN/$1"
	chmod 755 "$BIN/$1"
}
stub opkg 'echo "opkg $*" >>"$CALLS"
case $1 in
	download) : >"$PWD/${2}_2.90-r4_x86_64.ipk" ;;
	install) case $2 in /tmp/dnsmasq-full*) : >"$FICHA_ROOT/dnsmasq-full" ;; esac ;;
esac'
stub dnsmasq 'if [ -f "$FICHA_ROOT/dnsmasq-full" ]; then f="ipset nftset"; else f="no-ipset no-nftset"; fi
echo "Dnsmasq version 2.90  Copyright (c) 2000-2024 Simon Kelley"
echo "Compile time options: IPv6 GNU-getopt no-DBus UBus no-i18n no-IDN DHCP DHCPv6 no-Lua TFTP no-conntrack $f auth no-cryptohash no-DNSSEC loop-detect inotify dumpfile"'
stub nft 'echo "nft $*" >>"$CALLS"'
stub ndsctl 'exit 0'
stub wget 'echo "wget $*" >>"$CALLS"
echo "wget: server returned error: HTTP/1.1 400 Bad Request" >&2
exit 1'
stub wifi 'echo "wifi $*" >>"$CALLS"'
stub ip 'exit 0'
for svc in opennds dnsmasq cron; do
	printf '#!/bin/sh\necho "%s $1" >>"$CALLS"\ncase $1 in\n\trunning) [ -f "$FICHA_ROOT/%s.running" ] ;;\n\tstart|restart) : >"$FICHA_ROOT/%s.running" ;;\n\tstop) rm -f "$FICHA_ROOT/%s.running" ;;\nesac\n' \
		"$svc" "$svc" "$svc" "$svc" >"$R/etc/init.d/$svc"
	chmod 755 "$R/etc/init.d/$svc"
done

# ---- the fake router as a GL.iNet leaves the factory, openNDS installed -----------
echo "DISTRIB_ID='OpenWrt'" >"$R/etc/openwrt_release"
printf '#!/bin/sh\nexit 0\n' >"$R/usr/bin/opennds"
chmod 755 "$R/usr/bin/opennds"
cat >"$R/etc/config/opennds" <<'EOF'
S cfg01 opennds
O cfg01 enabled 0
O cfg01 gatewayinterface br-lan
O cfg01 login_option_enabled 1
L cfg01 trustedmac 00:00:c0:01:d0:1d
EOF
cat >"$R/etc/config/dhcp" <<'EOF'
S cfg01 dnsmasq
O cfg01 domain lan
S lan dhcp
O lan interface lan
O lan start 100
O lan limit 150
S cfg02 host
O cfg02 name printer
O cfg02 mac 11:22:33:44:55:66
O cfg02 ip 192.168.8.50
EOF
cat >"$R/etc/config/wireless" <<'EOF'
S radio0 wifi-device
O radio0 band 2g
S default_radio0 wifi-iface
O default_radio0 device radio0
O default_radio0 network lan
O default_radio0 mode ap
O default_radio0 ssid GL-MT3000-a1b
O default_radio0 encryption psk2
O default_radio0 key goodlife
S default_radio1 wifi-iface
O default_radio1 device radio1
O default_radio1 network lan
O default_radio1 mode ap
O default_radio1 ssid GL-MT3000-a1b-5G
O default_radio1 encryption psk2
O default_radio1 key goodlife
S guest2g wifi-iface
O guest2g device radio0
O guest2g network guest
O guest2g mode ap
O guest2g ssid GL-MT3000-a1b-Guest
O guest2g isolate 1
EOF
cat >"$R/etc/config/network" <<'EOF'
S lan interface
O lan device br-lan
O lan ipaddr 192.168.8.1
O lan netmask 255.255.255.0
EOF
echo "*/5 * * * * /usr/bin/gl_health_check" >"$R/etc/crontabs/root"
mkdir -p "$WORK/factory"
cp "$R/etc/config/opennds" "$R/etc/config/dhcp" "$R/etc/config/wireless" "$R/etc/crontabs/root" "$WORK/factory/"

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

MAC=a4:5e:60:d1:22:01
# setup.sh with a clean environment plus the given VAR=value words. Sets OUT and RC.
setup() {
	: >"$CALLS"
	OUT=$(cd "$WORK" && env -i PATH="$BIN" FICHA_ROOT="$R" CALLS="$CALLS" "$@" \
		"$BUSYBOX" ash "$HERE/setup.sh" ${ARGS:-} 2>&1)
	RC=$?
}
get() { FICHA_ROOT=$R PATH="$BIN" uci -q get "$1"; }
called() { grep -c "^$1\$" "$CALLS"; }
snapshot() { (cd "$R" && find etc usr -type f | sort | xargs md5sum); }

echo "== syntax"
"$BUSYBOX" ash -n "$HERE/setup.sh"
check "setup.sh parses under busybox ash" "$?" 0

echo "== refuses to run without the station's MAC, or with bad values"
setup
check "no STATION_MAC: exit 1" "$RC" 1
echo "$OUT" | grep -q "set STATION_MAC"
check "no STATION_MAC: says what to set" "$?" 0
setup STATION_MAC=a4:5e:60:d1:22
check "short STATION_MAC: exit 1" "$RC" 1
setup STATION_MAC=$MAC STATION_IP=192.168.8.1
check "STATION_IP = the router: exit 1" "$RC" 1
setup STATION_MAC=$MAC STATION_IP=192.168.8.300
check "STATION_IP out of range: exit 1" "$RC" 1
setup STATION_MAC=$MAC GATEWAYNAME="Ficha's"
check "a quote in GATEWAYNAME: exit 1" "$RC" 1
setup STATION_MAC=$MAC FREE_INTERNET_SECONDS=2min
check "FREE_INTERNET_SECONDS not a number: exit 1" "$RC" 1
check "nothing written by the refused runs" "$(cd "$R" && ls usr/lib etc/ficha 2>&1 | grep -c 'No such file')" 2

echo "== first run"
setup STATION_MAC=A4-5E-60-D1-22-01
check "exit 0" "$RC" 0
[ "$RC" = 0 ] || echo "$OUT"
check "dnsmasq-full: downloaded first, then dnsmasq removed, then installed" \
	"$(grep '^opkg' "$CALLS" | tr '\n' '|')" "opkg update|opkg download dnsmasq-full|opkg remove dnsmasq|opkg install /tmp/dnsmasq-full_2.90-r4_x86_64.ipk|"
check "section renamed to setup (openNDS 11 wants it)" "$(get opennds.setup)" opennds
check "anonymous section gone" "$(grep -c '^S cfg01' "$R/etc/config/opennds")" 0
check "enabled" "$(get opennds.setup.enabled)" 1
check "gatewayinterface" "$(get opennds.setup.gatewayinterface)" br-lan
check "gatewayname" "$(get opennds.setup.gatewayname)" Ficha
check "fasremoteip" "$(get opennds.setup.fasremoteip)" 192.168.8.20
check "fasport" "$(get opennds.setup.fasport)" 8000
check "faspath" "$(get opennds.setup.faspath)" /portal
check "fas_secure_enabled 0 (no key)" "$(get opennds.setup.fas_secure_enabled)" 0
check "login_option_enabled 0 (FAS)" "$(get opennds.setup.login_option_enabled)" 0
check "dhcp_default_url_enable 0" "$(get opennds.setup.dhcp_default_url_enable)" 0
check "sessiontimeout 2 minutes" "$(get opennds.setup.sessiontimeout)" 2
check "checkinterval" "$(get opennds.setup.checkinterval)" 10
check "binauth" "$(get opennds.setup.binauth)" /usr/lib/ficha/binauth.sh
check "custombinauth" "$(get opennds.setup.custombinauth)" /usr/lib/ficha/custombinauth.sh
check "debuglevel 0" "$(get opennds.setup.debuglevel)" 0
check "walled garden" "$(get opennds.setup.walledgarden_fqdn_list)" \
	"ficha-stellar.vercel.app horizon-testnet.stellar.org soroban-testnet.stellar.org friendbot.stellar.org testanchor.stellar.org"
check "walled garden ports" "$(get opennds.setup.walledgarden_port_list)" 443
check "trusted: the operator's own MAC kept, the station added (normalised)" \
	"$(get opennds.setup.trustedmac)" "00:00:c0:01:d0:1d a4:5e:60:d1:22:01"
check "no faskey set" "$(get opennds.setup.faskey)" ""
check "reservation" "$(get dhcp.ficha_station).$(get dhcp.ficha_station.mac).$(get dhcp.ficha_station.ip)" "host.a4:5e:60:d1:22:01.192.168.8.20"
check "other reservations untouched" "$(get dhcp.cfg02.ip)" 192.168.8.50
cmp -s "$HERE/binauth.sh" "$R/usr/lib/ficha/binauth.sh"
check "binauth.sh installed" "$?" 0
cmp -s "$HERE/custombinauth.sh" "$R/usr/lib/ficha/custombinauth.sh"
check "custombinauth.sh installed" "$?" 0
check "binauth.sh executable" "$(stat -c %a "$R/usr/lib/ficha/binauth.sh")" 755
check "freewifi.conf" "$(cat "$R/etc/ficha/freewifi.conf")" "FREE_INTERNET_SECONDS=120"
check "cron line added once" "$(grep -c 'binauth.sh rotate$' "$R/etc/crontabs/root")" 1
check "GL.iNet's own cron line kept" "$(grep -c gl_health_check "$R/etc/crontabs/root")" 1
check "openNDS restarted" "$(called 'opennds restart')" 1
check "dnsmasq restarted (reservation)" "$(called 'dnsmasq restart')" 1
check "Wi-Fi untouched (no SSID given)" "$(called 'wifi reload')" 0
cmp -s "$WORK/factory/wireless" "$R/etc/config/wireless"
check "wireless config untouched" "$?" 0
check "backup of the factory opennds config" "$(cmp -s "$WORK/factory/opennds" "$R/etc/ficha/backup/opennds" && echo same)" same
check "nothing left uncommitted" "$(ls "$R/tmp/.uci" | wc -l)" 0
echo "$OUT" | grep -q "the station's portal answers"
check "any HTTP answer from the portal counts as reachable" "$?" 0
echo "$OUT" | grep -q "^WARNING"
check "no warnings" "$?" 1
echo "$OUT" | grep -q "^NOTE: the free internet is a courtesy limit, not a hard one: the walled garden opens addresses that Vercel and Cloudflare share"
check "says the free internet is a courtesy limit, not a hard one (shared walled garden addresses)" "$?" 0

echo "== second run, same values: nothing changes, nothing restarts"
BEFORE=$(snapshot)
setup STATION_MAC=$MAC
check "exit 0" "$RC" 0
check "every file the same" "$(snapshot)" "$BEFORE"
check "openNDS not restarted" "$(called 'opennds restart')" 0
check "dnsmasq not restarted" "$(called 'dnsmasq restart')" 0
check "no package work" "$(grep -c '^opkg' "$CALLS")" 0

echo "== Wi-Fi name and an open network"
setup STATION_MAC=$MAC SSID="Ficha SOS" WIFI_OPEN=1
check "exit 0" "$RC" 0
check "2.4 GHz LAN ssid (with a space)" "$(get wireless.default_radio0.ssid)" "Ficha SOS"
check "5 GHz LAN ssid" "$(get wireless.default_radio1.ssid)" "Ficha SOS"
check "open" "$(get wireless.default_radio0.encryption)" none
check "no key kept" "$(get wireless.default_radio0.key)" ""
check "guest network untouched" "$(get wireless.guest2g.ssid)" GL-MT3000-a1b-Guest
check "Wi-Fi reloaded once" "$(called 'wifi reload')" 1
check "openNDS not restarted for a Wi-Fi change" "$(called 'opennds restart')" 0
setup STATION_MAC=$MAC SSID="Ficha SOS" WIFI_OPEN=1
check "again: no reload" "$(called 'wifi reload')" 0

echo "== a new station laptop, a new allowance"
setup STATION_MAC=a4:5e:60:d1:22:99 FREE_INTERNET_SECONDS=300
check "exit 0" "$RC" 0
check "old station no longer trusted, new one trusted, operator's kept" \
	"$(get opennds.setup.trustedmac)" "00:00:c0:01:d0:1d a4:5e:60:d1:22:99"
check "reservation follows" "$(get dhcp.ficha_station.mac)" a4:5e:60:d1:22:99
check "sessiontimeout 5 minutes" "$(get opennds.setup.sessiontimeout)" 5
check "freewifi.conf" "$(cat "$R/etc/ficha/freewifi.conf")" "FREE_INTERNET_SECONDS=300"
check "openNDS restarted" "$(called 'opennds restart')" 1
check "the first backup is kept (the state before Ficha)" "$(cmp -s "$WORK/factory/opennds" "$R/etc/ficha/backup/opennds" && echo same)" same

echo "== --check"
ARGS=--check setup
check "exit 0" "$RC" 0
echo "$OUT" | grep -q "^opennds.setup.fasremoteip='192.168.8.20'$"
check "shows the settings" "$?" 0
echo "$OUT" | grep -q "Midnight cron job: present"
check "shows the cron job" "$?" 0
echo "$OUT" | grep -q "^NOTE: the free internet is a courtesy limit, not a hard one"
check "--check says it too" "$?" 0

echo "== --remove"
ARGS=--remove setup
check "exit 0" "$RC" 0
check "opennds config back to the factory's" "$(cmp -s "$WORK/factory/opennds" "$R/etc/config/opennds" && echo same)" same
check "reservation gone" "$(get dhcp.ficha_station)" ""
check "other reservation kept" "$(get dhcp.cfg02.ip)" 192.168.8.50
check "crontab back to the factory's" "$(cmp -s "$WORK/factory/root" "$R/etc/crontabs/root" && echo same)" same
check "Ficha files gone" "$(ls "$R/usr/lib/ficha" "$R/etc/ficha/freewifi.conf" 2>/dev/null | wc -l)" 0
check "openNDS stopped and disabled" "$(called 'opennds stop')$(called 'opennds disable')" 11
echo "$OUT" | grep -q "cp /etc/ficha/backup/wireless /etc/config/wireless"
check "says how to restore the changed Wi-Fi" "$?" 0

echo "== no secret in the scripts"
grep -nE "^[^#]*(faskey|password|secret|PRIVATE|BEGIN)" "$HERE/setup.sh" "$HERE/binauth.sh" "$HERE/custombinauth.sh"
check "no key, password or secret set anywhere" "$?" 1

if command -v shellcheck >/dev/null 2>&1; then
	echo "== shellcheck"
	shellcheck -s sh "$HERE/setup.sh"
	check "shellcheck -s sh setup.sh: no findings" "$?" 0
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
