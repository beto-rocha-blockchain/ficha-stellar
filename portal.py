"""The Wi-Fi portal of the free emergency minutes (docs/free-minutes.md).

The station's Wi-Fi router (OpenWrt with openNDS) sends each phone that
joins to GET /portal on this station, with openNDS's FAS level 0 query:

    /portal?authaction=http://<gw>:<port>/<authdir>/?clientip=<ip>&gatewayname=<name>&tok=<token>&redir=<url>

(openNDS writes the clientip inside authaction's value; level 0 sends no
MAC). The portal shows the emergency numbers first, the two free buttons,
and the pay link of the session on the station screen. Free internet is a
redirect to authaction?tok=..&redir=..: openNDS opens the internet for that
phone, and its binauth script on the router holds the per-MAC daily quota,
so a phone that calls the auth URL by itself still gets no more that way.
It is a courtesy limit, not a hard one: the router's walled garden opens
addresses shared with other sites, with no sign-in (openwrt/README.md). The
station holds no secret of the router's (no FAS key, no password).

A phone is its Wi-Fi MAC address, which the station reads from its own
neighbour (ARP) table for the address the request came from: the station is
on the router's LAN, so each phone reaches it directly. The MAC is never
stored (freeminutes.py). WIFI_PORTAL=simulate (no router) also accepts a
test MAC, but only from this computer.

With openNDS, only a phone on the router's LAN gets free minutes: the
request carries the router's auth URL, and the phone, that gateway and this
station's address the request came in on share the gateway's /24. With
HOST=0.0.0.0 the station also answers on any other network this computer is
on; there a phone is refused, unless someone writes a gateway of that
network into the URL by hand (openwrt/README.md says how to rule it out).

The page is rendered here, with everything it needs: no script, no CDN, no
internet. It works in the sign-in window phones open by themselves.
"""

from __future__ import annotations

import html
import ipaddress
import os
import re
import subprocess
from dataclasses import dataclass, field
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from config import BASE_DIR
from freeminutes import normalise_mac

# This computer's own test device in WIFI_PORTAL=simulate (a locally
# administered address: no real device has it).
SIMULATED_MAC = "02:00:00:00:00:01"
# What the portal's forms carry from the router's query to the next request.
CARRIED = ("authaction", "tok", "redir", "clientip", "gatewayname", "clientmac", "lang")
FORM_MAX_BYTES = 8192

_MAC_TEXT = re.compile(r"\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b", re.IGNORECASE)
# openNDS's auth URL: http://<gateway IPv4>[:port]/<authdir>/ (opennds_auth by default).
_AUTHACTION = re.compile(r"http://(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/([A-Za-z0-9_-]{1,64})/")
_TOKEN = re.compile(r"[A-Za-z0-9]{1,64}")
# Not under static/: served only filled in, by GET /portal.
TEMPLATE = BASE_DIR / "templates" / "portal.html"


# -- who is asking --------------------------------------------------------------
def peer_ip(host: str | None) -> str:
    """The request's source address, an IPv4-mapped IPv6 one as IPv4."""
    try:
        addr = ipaddress.ip_address((host or "").strip("[]"))
    except ValueError:
        return host or ""
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        return str(addr.ipv4_mapped)
    return str(addr)


def is_loopback(host: str | None) -> bool:
    try:
        return ipaddress.ip_address(peer_ip(host)).is_loopback
    except ValueError:
        return False


def neighbour_mac(ip: str) -> str | None:
    """The MAC address this computer's neighbour (ARP) table has for `ip`, a
    device on the same LAN that has just talked to it; None when it has none.
    Linux: /proc/net/arp. Windows, macOS: the arp command."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if addr.is_loopback or addr.is_unspecified or addr.is_multicast or addr.version != 4:
        return None
    try:
        with open("/proc/net/arp", encoding="ascii", errors="replace") as f:
            for line in f.read().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    return normalise_mac(parts[3])
        return None
    except OSError:
        pass
    cmd = ["arp", "-a", ip] if os.name == "nt" else ["arp", "-n", ip]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=3,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if ip in re.split(r"[\s()]+", line):
            m = _MAC_TEXT.search(line)
            if m:
                return normalise_mac(m.group(0))
    return None


# -- the router's query ---------------------------------------------------------------
def carried(query) -> dict[str, str]:
    """The parameters the portal keeps from one request to the next."""
    return {k: str(query.get(k, ""))[:2048] for k in CARRIED if query.get(k)}


def parse_form(body: bytes) -> dict[str, str]:
    """An application/x-www-form-urlencoded body (no multipart parser needed)."""
    pairs = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
    return {k: v[0] for k, v in pairs.items()}


def client_ip(params: dict[str, str]) -> str:
    """The phone's address as openNDS saw it: its own parameter, or (level 0)
    inside authaction's value."""
    if params.get("clientip"):
        return params["clientip"]
    _, _, inner = params.get("authaction", "").partition("?")
    return parse_qs(inner).get("clientip", [""])[0]


def auth_base(authaction: str) -> str | None:
    """openNDS's auth URL without its query, or None when it is not one: a
    private IPv4 gateway, http, one path segment. Anything else would make
    the station an open redirect."""
    base = (authaction or "").split("?", 1)[0]
    m = _AUTHACTION.fullmatch(base)
    if not m:
        return None
    try:
        ip = ipaddress.ip_address(m.group(1))
    except ValueError:
        return None
    if not ip.is_private or ip.is_loopback or ip.is_unspecified or ip.is_link_local:
        return None
    if m.group(2) and not 1 <= int(m.group(2)) <= 65535:
        return None
    return base


def router_lan(authaction: str) -> ipaddress.IPv4Network | None:
    """The router's LAN as openNDS's auth URL names it: its gateway's /24
    (a GL.iNet's 192.168.8.0/24; setup.sh assumes a /24 too). None when the
    request did not come through the router's sign-in."""
    base = auth_base(authaction)
    if base is None:
        return None
    return ipaddress.ip_network(f"{urlsplit(base).hostname}/24", strict=False)


def on_lan(lan: ipaddress.IPv4Network, *addresses: str | None) -> bool:
    """Every address is in lan (an IPv4-mapped IPv6 address as IPv4)."""
    for a in addresses:
        try:
            if ipaddress.ip_address(peer_ip(a)) not in lan:
                return False
        except ValueError:
            return False
    return True


def safe_redir(redir: str, fallback: str) -> str:
    """Where openNDS sends the phone once it is online: the page it asked
    for, when that is a plain http(s) URL, else `fallback`."""
    url = urlsplit(redir or "")
    if (url.scheme in ("http", "https") and url.netloc and len(redir) <= 2048
            and not any(c.isspace() or ord(c) < 32 for c in redir)):
        return redir
    return fallback


def auth_redirect(params: dict[str, str], fallback: str) -> str | None:
    """openNDS FAS level 0's way back: authaction?tok=<token>&redir=<url>.
    None when the request did not come through the router's sign-in."""
    base = auth_base(params.get("authaction", ""))
    tok = params.get("tok", "")
    if base is None or not _TOKEN.fullmatch(tok):
        return None
    return f"{base}?tok={quote(tok, safe='')}&redir={quote(safe_redir(params.get('redir', ''), fallback), safe='')}"


def lang_of(param: str | None, accept_language: str | None) -> str:
    """pt or en: the page's own choice, else the phone's first language."""
    if param in TEXT:
        return param
    first = (accept_language or "").split(",")[0].strip().lower()
    return "pt" if first.startswith("pt") else "en"


# -- the page -----------------------------------------------------------------------------
TEXT = {
    "en": {
        "html_lang": "en",
        "title": "Ficha · free emergency minutes",
        "sos_title": "Emergency",
        "sos_sub": "Calls to these numbers are free and need no internet.",
        "free_title": "Free emergency minutes",
        "free_sub": "Once a day, every phone gets {what}. Free, no account.",
        "and": " and ",
        "of_charge": "{t} of charging",
        "of_internet": "{t} of internet",
        "btn_charge": "{t} free charge",
        "btn_internet": "{t} free internet",
        "charge_ready": "Plug your phone into the station, then tap.",
        "internet_ready": "Opens the internet for this phone for {t}.",
        "used": "Used today. Again after midnight.",
        "charge_yours": "Your free charge: {left} left. Keep the phone plugged in.",
        "unknown_device_hint": "Join the station's Wi-Fi to use it.",
        "pay_title": "Pay with Ficha",
        "pay_sub": "Paying works on this Wi-Fi at any time, without using your free minutes.",
        "pay_btn": "Pay with Ficha",
        "pay_add": "Add time to the session now charging",
        "price": "1 ficha = {m} min = {p} {a}",
        "session": "session {s}",
        "pay_hint": "If this page opened by itself, the link may work better in your browser or in the Ficha app.",
        "pay_finishing": "The next session starts in a moment: reload this page.",
        "pay_oos": "Payments are paused: the station is out of service.",
        "pay_full": "The session now charging is at its limit.",
        "safe_title": "Stay safe",
        "safe_call": "In danger? Call {n} first: it is free, even without internet.",
        "safe_place": "Stay where there is light and people, and tell someone you trust where you are.",
        "safe_never": "This station never asks for passwords, PINs or bank details.",
        "privacy": "Your phone is recognised only by a code that changes every day. Ficha keeps no name, "
                   "no phone number, no IP and no MAC address.",
        "reset": "Free minutes start over at midnight.",
        "simulated": "SIMULATED: no Wi-Fi router here. Free internet is recorded, not given.",
        "switch": "Português",
        "msg": {
            "charge_started": "Free charge on for {c}. Plug your phone into the station now.",
            "charge_used": "This phone already had its free charge today. It starts over at midnight.",
            "internet_used": "This phone already had its free internet today. It starts over at midnight. "
                             "Paying with Ficha still works.",
            "internet_simulated": "Internet granted (simulated): on a real station the Wi-Fi router now opens "
                                  "{i} of internet for this phone.",
            "internet_on": "You are online for {i}.",
            "charge_off": "This station gives no free charge.",
            "internet_off": "This station gives no free internet.",
            "busy": "The station is charging a paid session. Try again when it is free.",
            "busy_free": "The station is giving a free charge right now. Try again in a moment.",
            "busy_courtesy": "The station is giving a courtesy charge right now. Try again in a moment.",
            "finishing": "The station is finishing a session. Try again in a few seconds.",
            "relay": "The station is out of service: its power switch is not answering.",
            "no_gateway": "Open this page from the station's Wi-Fi sign-in page to get the free minutes.",
            "not_lan": "This phone is not on the station's Wi-Fi. Join it, then open this page from its sign-in "
                       "page.",
            "unknown_device": "This phone could not be recognised. Join the station's Wi-Fi and open this page "
                              "again.",
            "not_direct": "The station cannot see this phone directly on its Wi-Fi. Please tell the operator.",
            "bad_mac": "That test MAC address is not valid.",
            "record_failed": "The station could not record it, so nothing was given. Try again.",
        },
    },
    "pt": {
        "html_lang": "pt",
        "title": "Ficha · minutos de emergência grátis",
        "sos_title": "Emergência",
        "sos_sub": "Ligações para estes números são gratuitas e não precisam de internet.",
        "free_title": "Minutos de emergência grátis",
        "free_sub": "Uma vez por dia, cada telefone recebe {what}. Grátis, sem conta.",
        "and": " e ",
        "of_charge": "{t} de carga",
        "of_internet": "{t} de internet",
        "btn_charge": "{t} de carga grátis",
        "btn_internet": "{t} de internet grátis",
        "charge_ready": "Ligue o telefone na estação e toque.",
        "internet_ready": "Libera a internet para este telefone por {t}.",
        "used": "Já usado hoje. De novo depois da meia-noite.",
        "charge_yours": "Sua carga grátis: faltam {left}. Mantenha o telefone ligado.",
        "unknown_device_hint": "Entre no Wi-Fi da estação para usar.",
        "pay_title": "Pagar com Ficha",
        "pay_sub": "O pagamento funciona neste Wi-Fi a qualquer momento, sem gastar os seus minutos grátis.",
        "pay_btn": "Pagar com Ficha",
        "pay_add": "Adicionar tempo à sessão em curso",
        "price": "1 ficha = {m} min = {p} {a}",
        "session": "sessão {s}",
        "pay_hint": "Se esta página abriu sozinha, o link pode funcionar melhor no navegador ou no app Ficha.",
        "pay_finishing": "A próxima sessão começa já: recarregue esta página.",
        "pay_oos": "Pagamentos em pausa: a estação está fora de serviço.",
        "pay_full": "A sessão em curso chegou ao limite.",
        "safe_title": "Fique em segurança",
        "safe_call": "Em perigo? Ligue primeiro para {n}: é grátis, mesmo sem internet.",
        "safe_place": "Fique onde há luz e pessoas, e diga a alguém de confiança onde você está.",
        "safe_never": "Esta estação nunca pede senhas, PINs ou dados bancários.",
        "privacy": "O seu telefone é reconhecido só por um código que muda todos os dias. A Ficha não guarda "
                   "nome, número de telefone, IP nem endereço MAC.",
        "reset": "Os minutos grátis recomeçam à meia-noite.",
        "simulated": "SIMULADO: sem roteador Wi-Fi aqui. A internet grátis é registrada, não liberada.",
        "switch": "English",
        "msg": {
            "charge_started": "Carga grátis ligada por {c}. Ligue o telefone na estação agora.",
            "charge_used": "Este telefone já usou a carga grátis hoje. Recomeça à meia-noite.",
            "internet_used": "Este telefone já usou a internet grátis hoje. Recomeça à meia-noite. "
                             "Pagar com Ficha continua funcionando.",
            "internet_simulated": "Internet liberada (simulado): numa estação real o roteador Wi-Fi abre agora "
                                  "{i} de internet para este telefone.",
            "internet_on": "Você está online por {i}.",
            "charge_off": "Esta estação não dá carga grátis.",
            "internet_off": "Esta estação não dá internet grátis.",
            "busy": "A estação está carregando uma sessão paga. Tente quando estiver livre.",
            "busy_free": "A estação está dando uma carga grátis agora. Tente daqui a pouco.",
            "busy_courtesy": "A estação está dando uma carga de cortesia agora. Tente daqui a pouco.",
            "finishing": "A estação está encerrando uma sessão. Tente em alguns segundos.",
            "relay": "A estação está fora de serviço: o interruptor de energia não responde.",
            "no_gateway": "Abra esta página pela página de acesso do Wi-Fi da estação para ter os minutos grátis.",
            "not_lan": "Este telefone não está no Wi-Fi da estação. Entre nele e abra esta página pela página de "
                       "acesso.",
            "unknown_device": "Não foi possível reconhecer este telefone. Entre no Wi-Fi da estação e abra esta "
                              "página de novo.",
            "not_direct": "A estação não vê este telefone diretamente no Wi-Fi. Avise o operador.",
            "bad_mac": "Esse endereço MAC de teste não é válido.",
            "record_failed": "A estação não conseguiu registrar, então nada foi liberado. Tente de novo.",
        },
    },
}
# Messages that report something given, shown in the success color.
GOOD = ("charge_started", "internet_simulated", "internet_on")


def duration(seconds: int) -> str:
    """120 -> '2 min', 90 -> '90 s'."""
    return f"{seconds // 60} min" if seconds % 60 == 0 else f"{seconds} s"


def mmss(seconds: int) -> str:
    s = max(0, int(seconds))
    return f"{s // 60}:{s % 60:02d}"


@dataclass
class View:
    """Everything the page shows; main.py fills it from the station."""
    lang: str
    mode: str  # opennds | simulate
    station_name: str
    station_id: str
    emergency: tuple[tuple[str, str], ...]
    charge_seconds: int
    internet_seconds: int
    device_known: bool
    charge_used: bool = False
    internet_used: bool = False
    charge_block: str | None = None  # why no free charge now (Station.free_charge_refusal())
    charge_yours_left: int | None = None  # this phone's free charge is running: seconds left
    pay_uri: str | None = None
    pay_add: bool = False  # the session on screen is charging: a payment adds time to it
    pay_block: str | None = None  # finishing | oos | full
    ficha_minutes: int = 0
    ficha_price: str = ""
    asset: str = ""
    session_id: str = ""
    message: str | None = None
    carried: dict[str, str] = field(default_factory=dict)


def _e(text) -> str:
    return html.escape(str(text), quote=True)


def portal_url(params: dict[str, str], **extra: str) -> str:
    q = {**params, **{k: v for k, v in extra.items() if v}}
    return "/portal" + ("?" + urlencode(q) if q else "")


_BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2 4 14h7l-1 8 10-12h-7z"/></svg>'
_WIFI = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z'
         'M4.9 12.6a10 10 0 0 1 14.2 0l-1.8 1.8a7.5 7.5 0 0 0-10.6 0Zm-3.5-3.5a15 15 0 0 1 21.2 0l-1.8 1.8a12.5 12.5 '
         '0 0 0-17.6 0Zm7 7a5 5 0 0 1 7.2 0L12 19.7Z"/></svg>')
_PHONE = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 '
          '1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 '
          '1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1Z"/></svg>')


def _form(action: str, params: dict[str, str], button: str, enabled: bool, icon: str) -> str:
    hidden = "".join(f'<input type="hidden" name="{_e(k)}" value="{_e(v)}">' for k, v in params.items())
    return (f'<form method="post" action="{_e(action)}">{hidden}'
            f'<button type="submit" class="free-btn"{"" if enabled else " disabled"}>{icon}<span>{_e(button)}'
            f'</span></button></form>')


def page(v: View) -> str:
    t = TEXT[v.lang]
    params = dict(v.carried, lang=v.lang)
    first = v.emergency[0][1] if v.emergency else ""

    calls = "".join(
        f'<a class="call" href="tel:{_e(number)}">{_PHONE}<b class="num">{_e(number)}</b>'
        f'<span>{_e(label)}</span></a>' for label, number in v.emergency)

    message = ""
    if v.message in t["msg"]:
        text = t["msg"][v.message].format(c=duration(v.charge_seconds), i=duration(v.internet_seconds))
        message = f'<p class="msg {"good" if v.message in GOOD else "warn"}" role="status">{_e(text)}</p>'

    parts = []
    if v.charge_seconds:
        parts.append(t["of_charge"].format(t=duration(v.charge_seconds)))
    if v.internet_seconds:
        parts.append(t["of_internet"].format(t=duration(v.internet_seconds)))
    free = ""
    if parts:
        rows = []
        if v.charge_seconds:
            if v.charge_yours_left is not None:
                note, ok = t["charge_yours"].format(left=mmss(v.charge_yours_left)), False
            elif v.charge_used:
                note, ok = t["used"], False
            elif v.charge_block:
                note, ok = t["msg"].get(v.charge_block, ""), False
            elif not v.device_known:
                note, ok = t["unknown_device_hint"], True
            else:
                note, ok = t["charge_ready"], True
            rows.append(f'<div class="free-row">{_form("/portal/charge", params, t["btn_charge"].format(t=duration(v.charge_seconds)), ok, _BOLT)}'
                        f'<p class="note">{_e(note)}</p></div>')
        if v.internet_seconds:
            if v.internet_used:
                note, ok = t["used"], False
            elif not v.device_known:
                note, ok = t["unknown_device_hint"], True
            else:
                note, ok = t["internet_ready"].format(t=duration(v.internet_seconds)), True
            rows.append(f'<div class="free-row">{_form("/portal/internet", params, t["btn_internet"].format(t=duration(v.internet_seconds)), ok, _WIFI)}'
                        f'<p class="note">{_e(note)}</p></div>')
        free = (f'<section class="card free"><h2>{_e(t["free_title"])}</h2>'
                f'<p class="sub">{_e(t["free_sub"].format(what=t["and"].join(parts)))}</p>{"".join(rows)}'
                f'<p class="note">{_e(t["reset"])}</p></section>')

    if v.pay_uri:
        pay_body = (f'<a class="pay-btn" href="{_e(v.pay_uri)}">{_e(t["pay_add"] if v.pay_add else t["pay_btn"])}</a>'
                    f'<p class="note">{_e(t["price"].format(m=v.ficha_minutes, p=v.ficha_price, a=v.asset))}'
                    f' · <span class="mono">{_e(t["session"].format(s=v.session_id))}</span></p>'
                    f'<p class="note">{_e(t["pay_hint"])}</p>')
    else:
        pay_body = f'<p class="note">{_e(t["pay_" + (v.pay_block or "finishing")])}</p>'
    pay = (f'<section class="card pay"><h2>{_e(t["pay_title"])}</h2><p class="sub">{_e(t["pay_sub"])}</p>'
           f'{pay_body}</section>')

    safety = (f'<section class="card safe"><h2>{_e(t["safe_title"])}</h2><ul>'
              + (f'<li>{_e(t["safe_call"].format(n=first))}</li>' if first else "")
              + f'<li>{_e(t["safe_place"])}</li><li>{_e(t["safe_never"])}</li>'
              f'<li>{_e(t["privacy"])}</li></ul></section>')

    station = " · ".join(_e(x) for x in (v.station_name, v.station_id) if x)
    # A free charge under way: the page counts it down by reloading (no script).
    refresh = (f'<meta http-equiv="refresh" content="15; url={_e(portal_url(params))}">'
               if v.charge_yours_left is not None or v.charge_block in ("busy_free", "busy_courtesy", "finishing")
               else "")
    switch_lang = "en" if v.lang == "pt" else "pt"
    values = {
        "lang": _e(t["html_lang"]),
        "title": _e(t["title"]),
        "refresh": refresh,
        "station": station,
        "switch_url": _e(portal_url(dict(v.carried), lang=switch_lang)),
        "switch": _e(t["switch"]),
        "simulated": f'<p class="sim">{_e(t["simulated"])}</p>' if v.mode == "simulate" else "",
        "sos_title": _e(t["sos_title"]),
        "sos_sub": _e(t["sos_sub"]),
        "calls": calls,
        "message": message,
        "free": free,
        "pay": pay,
        "safety": safety,
    }
    template = TEMPLATE.read_text(encoding="utf-8")
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values[m.group(1)], template)
