#!/usr/bin/env bash
# Populate the GitHub repo secrets that .github/workflows/release.yml reads to
# sign and notarize the macOS build.
#
# Run this once, by hand, on the Mac that holds the Developer ID private key.
#
# Design constraint: no secret value is ever echoed, passed as a command-line
# argument (visible in `ps`), or written anywhere but a mode-600 temp file that
# is shredded on exit. Passwords are read with `read -s` and handed to `gh`
# through stdin. That is why this is a script you run rather than a list of
# commands someone pastes into a terminal with history on.
#
# Usage:
#   ./scripts/setup-macos-signing-secrets.sh /path/to/DeveloperID.p12
set -euo pipefail

REPO="float-ritual-stack/floatty"
IDENTITY="Developer ID Application: Evan Schultz (4JCC4C7XUG)"

die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- preflight
step "Preflight"

command -v gh >/dev/null || die "gh not installed — brew install gh"
gh auth status >/dev/null 2>&1 || die "gh not authenticated — run: gh auth login"

security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY" \
  || die "signing identity not found in your keychain: $IDENTITY"
echo "signing identity present: $IDENTITY"

P12="${1:-}"
if [ -z "$P12" ]; then
  cat <<'EOF'

No .p12 path given. Export one first — this step is deliberately manual.

Why it is not scripted: `security export` has no per-identity filter. It would
export every identity in the login keychain, which on this Mac includes the
Mosyle MDM enrollment identity. Shipping that into a public repo's secrets is
not acceptable, so the export goes through the GUI where you pick exactly one.

  1. Open Keychain Access → login → My Certificates
  2. Find "Developer ID Application: Evan Schultz (4JCC4C7XUG)"
  3. Expand the triangle so BOTH the certificate and its private key are selected
  4. Right-click → Export 2 items… → format: Personal Information Exchange (.p12)
  5. Set a strong password (you will type it into this script next — it is not
     stored anywhere except your keychain and the GitHub secret)

Then re-run:  ./scripts/setup-macos-signing-secrets.sh ~/Desktop/DeveloperID.p12
EOF
  exit 1
fi

[ -f "$P12" ] || die "no such file: $P12"

# Keychain Access still exports with pbeWithSHA1And40BitRC2-CBC. OpenSSL 3.x
# treats that as legacy and refuses it without -legacy; LibreSSL (which is what
# /usr/bin/openssl is on macOS) reads it natively and has no such flag. Which
# binary wins depends on PATH, so probe rather than assume.
LEGACY=""
if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then LEGACY="-legacy"; fi

echo "p12 file: $P12"
echo "openssl:  $(openssl version)${LEGACY:+  (using -legacy)}"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# ------------------------------------------------------- certificate secrets
step "Certificate"

# Reuse an already-stashed password when it still opens THIS file. Re-typing a
# password you have already committed to the keychain adds friction and a typo
# surface without adding any protection.
P12_PASS="$(security find-generic-password -s floatty/apple-p12-password -w 2>/dev/null || true)"
if [ -n "$P12_PASS" ] \
   && printf '%s' "$P12_PASS" \
      | openssl pkcs12 -in "$P12" -nokeys -noout $LEGACY -passin stdin >/dev/null 2>&1; then
  echo "reusing the password already stashed at floatty/apple-p12-password"
else
  P12_PASS=""
  printf 'Password you set on the .p12 (input hidden): '
  read -rs P12_PASS
  printf '\n'
  [ -n "$P12_PASS" ] || die "empty password"
fi

# Prove the password before shipping it anywhere — a wrong password here would
# fail deep inside a CI build with an opaque error. The password goes in on
# stdin, never argv (`ps`) and never the environment.
if ! printf '%s' "$P12_PASS" \
     | openssl pkcs12 -in "$P12" -nokeys -noout $LEGACY -passin stdin >/dev/null 2>&1; then
  unset P12_PASS
  die "that password does not open $P12"
fi

# A .p12 holding only the certificate signs nothing. That failure would
# otherwise stay invisible until a CI build died with an opaque codesign error.
if ! printf '%s' "$P12_PASS" \
     | openssl pkcs12 -in "$P12" -nocerts -noout $LEGACY -passin stdin >/dev/null 2>&1; then
  unset P12_PASS
  die "$P12 has no private key in it — re-export the certificate row under
       Keychain Access → login → My Certificates (not the plain Certificates
       category, and not the key on its own)"
fi

# Confirm it is the RIGHT certificate, not just a well-formed one. Both Apple
# keys are 40-char strings that look alike; only the subject settles it.
P12_SUBJECT="$(printf '%s' "$P12_PASS" \
  | openssl pkcs12 -in "$P12" -nokeys -clcerts $LEGACY -passin stdin 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null)"
case "$P12_SUBJECT" in
  *"Developer ID Application: Evan Schultz"*) ;;
  *) unset P12_PASS; die "wrong certificate in $P12 — subject is: $P12_SUBJECT" ;;
esac
echo "verified: password opens it, private key present, subject is the Developer ID Application cert"

# Stash in the login keychain so a future re-run can consume it by reference
# instead of asking again. -U upserts.
#
# The value is fed TWICE because bare `-w` prompts for the password and then
# for a retype; a single-value pipe fails the confirmation. Feeding it on stdin
# rather than as `-w "$value"` keeps it out of argv, where `ps` would show it.
printf '%s\n%s\n' "$P12_PASS" "$P12_PASS" \
  | security add-generic-password -U -a floatty -s floatty/apple-p12-password -w >/dev/null 2>&1
echo "password stashed in keychain as floatty/apple-p12-password"

openssl base64 -A -in "$P12" -out "$TMP/cert.b64"
gh secret set APPLE_CERTIFICATE          --repo "$REPO" < "$TMP/cert.b64"
printf '%s' "$P12_PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO"
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY     --repo "$REPO"
unset P12_PASS
echo "set APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY"

# ------------------------------------------------------ notarization secrets
step "Notarization"

cat <<'EOF'
Notarization is what stops Gatekeeper from refusing the app on someone else's
Mac. Signing alone is not enough — an unnotarized signed app still gets blocked.

You need an app-specific password (NOT your Apple ID password):
  appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate

Leave the Apple ID blank to skip this section; the build will still sign, it
just will not notarize.
EOF

printf '\nApple ID email (blank to skip notarization): '
read -r APPLE_ID_EMAIL

if [ -n "$APPLE_ID_EMAIL" ]; then
  TEAM_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')"
  [ -n "$TEAM_ID" ] || die "could not parse team id out of the identity string"

  # Ask until Apple actually accepts the credentials.
  #
  # An earlier version of this script warned on rejection and stored the value
  # anyway. That is how a regular Apple ID password — 12 characters, no dashes —
  # reached the repo secret and failed a real build with HTTP 401 at the very
  # last step, after the whole app had already compiled and signed. Rejected
  # credentials are not worth storing, so this refuses to.
  #
  # Caveat, stated rather than hidden: notarytool only accepts the password as
  # `--password`, so for the life of that one command it is visible in `ps` to
  # other local users. Everything else in this script avoids argv.
  ASP=""
  while : ; do
    printf 'App-specific password (input hidden): '
    read -rs ASP
    printf '\n'
    [ -n "$ASP" ] || { echo "  empty — try again"; continue; }

    # Shape check first, because it names the actual mistake. Apple issues
    # these as four dash-separated groups of four, e.g. abcd-efgh-ijkl-mnop.
    case "$ASP" in
      ????-????-????-????) ;;
      *) echo "  that is ${#ASP} characters and not in xxxx-xxxx-xxxx-xxxx form."
         echo "  An app-specific password is NOT your Apple ID password — generate one at"
         echo "  appleid.apple.com → Sign-In and Security → App-Specific Passwords."
         continue ;;
    esac

    echo "  checking against Apple's notary service…"
    if xcrun notarytool history --apple-id "$APPLE_ID_EMAIL" \
         --password "$ASP" --team-id "$TEAM_ID" >/dev/null 2>&1; then
      echo "  accepted"
      break
    fi
    echo "  Apple rejected those credentials (401)."
    echo "  Check the Apple ID is '$APPLE_ID_EMAIL' and that it belongs to team $TEAM_ID."
  done

  # Fed twice for the same reason as the .p12 password above (prompt + retype).
  printf '%s\n%s\n' "$ASP" "$ASP" | security add-generic-password -U \
    -a "$APPLE_ID_EMAIL" -s floatty/apple-app-specific-password -w >/dev/null 2>&1

  printf '%s' "$APPLE_ID_EMAIL" | gh secret set APPLE_ID       --repo "$REPO"
  printf '%s' "$ASP"            | gh secret set APPLE_PASSWORD --repo "$REPO"
  printf '%s' "$TEAM_ID"        | gh secret set APPLE_TEAM_ID  --repo "$REPO"
  unset ASP
  echo "set APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID (team $TEAM_ID)"
else
  echo "skipped — builds will be signed but not notarized"
fi

# ------------------------------------------------------------------- report
step "Secrets now on $REPO"
gh secret list --repo "$REPO"

cat <<'EOF'

Names and timestamps only — GitHub never reveals a secret's value back, and
neither did this script.

Next: run the release workflow.
  gh workflow run "release (macOS)" --repo float-ritual-stack/floatty
EOF
