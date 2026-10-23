# Ficha: the adapter for openNDS 11 and later (sourced, not run).
#
# From openNDS 11 "option binauth" is ignored: openNDS always runs its own
# /usr/lib/opennds/binauth_log.sh, which sources the file named by
# "option custombinauth" (this one) with its arguments still in $1, $2, ...,
# then prints "$sessiontimeout $upload_rate ..." and exits with $exitlevel.
# This asks Ficha's binauth.sh, so openNDS 11 makes the same decision as
# openNDS 9 and 10 do when they run binauth.sh directly.
#
# Sourced into binauth_log.sh: every name here starts with ficha_, and it never exits.
# exitlevel and sessiontimeout belong to binauth_log.sh, which reads them after this.
# shellcheck shell=sh disable=SC2034
if [ "$1" = "auth_client" ]; then
	ficha_answer=$("${FICHA_BINAUTH:-/usr/lib/ficha/binauth.sh}" "$@")
	ficha_seconds=${ficha_answer%% *}
	case $ficha_seconds in
		'' | *[!0-9]*) exitlevel=1 ;;
		*) sessiontimeout=$ficha_seconds ;;
	esac
fi
