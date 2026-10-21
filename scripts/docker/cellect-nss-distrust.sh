#!/bin/sh
# Explicitly distrust (p,p,p) the compromised eMudhra CAs in the current
# user's NSS DB, $HOME/.pki/nssdb. Playwright's chrome-headless-shell has no
# managed-policy loader, so CADistrustedCertificates never reaches it; Chromium
# on Linux does honor distrust entries in the user's NSS DB.
# Idempotent: writes only while coverage is short of 17. With --check it only
# verifies. Exits non-zero unless all 17 fingerprints are distrusted.
set -eu
pems=/etc/cellect/emudhra-distrust
db="$HOME/.pki/nssdb"
# SHA-256 of the 16 compromised intermediates and emSign ECC Root CA - G3. A
# constant, never derived from $pems, so a missing PEM lowers coverage.
expected='0164D7CEAE5BB909C272AF151FF44B1177AE9B47D9424B94F1D9558C30934D19
42C4ACCD12C4F59597925E1A08A7A90102608543809308D50EC427E118BA1493
432EC25F0D28DE9006D97BF752F17BBB2CD41F669933FCB072D9A1148D0261F3
45A883F349AEDFD5F3A649B5498FFB121712BA8B448F3F2A91DBC5A766FCDDBE
4B2460A466F95FD40113BCDCCA2CEB29B3B093921DE45474DA7DF48874C630B1
579480AEA166290BD3C643589E795FC0D0E54E86505D180F1DFF99EFD3199512
5F1DED4DD590AF74631290CF073B122A2AAC6A1FA479778A0BD43579BD832699
62B7F9868263F72F6911FC78CEAF72C1979158B7368BF648683BB2AA39B02E72
7485B51C0ED192878FA1D2F948FB529AE1842CC5086C4B67F7BE5B2039DE9489
84112972B8E59D14560AE7E7119654474AAD119990CF3722BFC1E3B91615E1FD
86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B
98B896625C0C230ADEEC3EB2CF6AAD5001ECF9156A68644E82374CE5833BC25B
9E39DE2881273ACC225A149C72BA3E0F51424963669AB633EE1DC7DF5DB067B4
A496E23AC0CAB8155FC9B117B97EAE368EFCBB9041AEC8804D5A308D2D01C2D8
CB6E15165AC802E9B3F993F16C25D41F4E81C21EBDE71AE1B012AC00BF9C7C3F
E7568FE6E12331F4FD7DE61DA4C7559D0F8EB192A218D4741A3BA75184333838
FD9D5C2DBBD4995AB69B8D50C439D9527B00529199C2FD01B2174EB58F07021F'

# A nickname can name several certificates with different trust. Read each
# certificate's own fingerprint and flags, never the nickname's summary row.
state() {
  [ -e "$db/cert9.db" ] || return 0
  certutil -L -d "sql:$db" \
    | sed -n -E 's/[[:space:]]+[^[:space:]]*,[^[:space:]]*,[^[:space:]]*[[:space:]]*$//p' \
    | sort -u \
    | while IFS= read -r nick; do
        [ -n "$nick" ] || continue
        printf 'NICK:%s\n' "$nick"
        certutil -L -d "sql:$db" -n "$nick"
      done \
    | awk '
        function flush() {
          if (fp != "") print fp, ((s == "Terminal Record;" && e == "Terminal Record;" && o == "Terminal Record;") ? "ppp" : "other"), nick
          fp = ""; s = ""; e = ""; o = ""; sec = ""; trust = 0
        }
        /^NICK:/ { flush(); nick = substr($0, 6); next }
        /^Certificate:/ { flush(); next }
        /Fingerprint \(SHA-256\):/ { getline; gsub(/[[:space:]:]/, ""); fp = toupper($0); next }
        /Certificate Trust Flags:/ { trust = 1; next }
        trust && /SSL Flags:/ { sec = "s"; next }
        trust && /Email Flags:/ { sec = "e"; next }
        trust && /Object Signing Flags:/ { sec = "o"; next }
        trust && sec != "" && NF {
          v = $0; sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v)
          if (sec == "s") s = s v ";"; else if (sec == "e") e = e v ";"; else o = o v ";"
        }
        END { flush() }'
}

coverage() {
  awk -v want="$expected" '
    BEGIN { n = split(want, w, /[[:space:]]+/); for (i = 1; i <= n; i++) if (w[i] != "") expected[w[i]] = 1 }
    $2 == "ppp" && ($1 in expected) && !($1 in seen) { seen[$1] = 1; c++ }
    END { print c + 0 }'
}

command -v certutil >/dev/null
command -v openssl >/dev/null
current=$(state)
have=$(printf '%s\n' "$current" | coverage)
failed=0
if [ "${1:-}" != --check ] && [ "$have" -ne 17 ]; then
  mkdir -p "$db"
  chmod 0700 "$HOME/.pki" "$db"
  [ -e "$db/cert9.db" ] || certutil -N -d "sql:$db" --empty-password >/dev/null
  for pem in "$pems"/*.pem; do
    [ -f "$pem" ] || continue
    fp=$(openssl x509 -in "$pem" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g; y/abcdef/ABCDEF/')
    if [ -z "$fp" ] || ! printf '%s\n' "$expected" | grep -q -x -F "$fp"; then
      failed=1
      continue
    fi
    line=$(printf '%s\n' "$current" | awk -v f="$fp" '$1 == f { print; exit }')
    [ "$(printf '%s\n' "$line" | awk '{ print $2 }')" != ppp ] || continue
    if [ -n "$line" ]; then
      nick=$(printf '%s\n' "$line" | cut -d' ' -f3-)
    else
      nick="cellect-distrust-$(printf '%s' "$fp" | cut -c1-16)"
    fi
    certutil -A -a -d "sql:$db" -n "$nick" -t p,p,p -i "$pem" >/dev/null || failed=1
  done
  have=$(state | coverage)
fi
echo "NSS distrust coverage $have/17 in $db (uid $(id -u))" >&2
[ "$have" -eq 17 ] && [ "$failed" -eq 0 ]
