#!/bin/sh
set -eu

case "${1-}" in
    SessionStart) script_name=codex-session-start.mjs ;;
    SessionEnd) script_name=codex-session-end.mjs ;;
    *) echo "Itsuki received an invalid hook name." >&2; exit 1 ;;
esac

# Node honors these before application code. Do not let repository-controlled
# environment files preload code, replace trust roots, log TLS keys/headers, or
# redirect the credential-bearing request through an inherited proxy.
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
unset NODE_USE_ENV_PROXY NODE_DEBUG NODE_DEBUG_NATIVE
unset SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE OPENSSL_CONF
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY

plugin_root=${PLUGIN_ROOT-}
case "$plugin_root" in
    /*) ;;
    *) echo "Codex did not provide an absolute PLUGIN_ROOT." >&2; exit 1 ;;
esac
plugin_root=$(CDPATH= cd "$plugin_root" 2>/dev/null && pwd -P) || {
    echo "The Codex plugin root is unavailable." >&2
    exit 1
}
script_path=$plugin_root/hooks/$script_name
if [ ! -f "$script_path" ] || [ -L "$script_path" ]; then
    echo "The resolved Codex hook script is not a plain file." >&2
    exit 1
fi

workspace=$(pwd -P)
excluded_root=$workspace
cursor=$workspace
while :; do
    if [ -d "$cursor/.git" ] || [ -f "$cursor/.git" ]; then
        excluded_root=$cursor
        break
    fi
    [ "$cursor" = / ] && break
    cursor=${cursor%/*}
    [ -n "$cursor" ] || cursor=/
done

node_path=
readlink_tool=
for tool in /usr/bin/readlink /bin/readlink; do
    if [ -x "$tool" ]; then readlink_tool=$tool; break; fi
done

resolve_node_candidate() {
    resolve_candidate=$1
    resolve_depth=0
    while [ -L "$resolve_candidate" ]; do
        [ -n "$readlink_tool" ] || return 1
        resolve_depth=$((resolve_depth + 1))
        [ "$resolve_depth" -le 16 ] || return 1
        resolve_target=$($readlink_tool "$resolve_candidate") || return 1
        case "$resolve_target" in
            /*) resolve_candidate=$resolve_target ;;
            *) resolve_candidate=${resolve_candidate%/*}/$resolve_target ;;
        esac
        resolve_directory=${resolve_candidate%/*}
        resolve_basename=${resolve_candidate##*/}
        resolve_directory=$(CDPATH= cd "$resolve_directory" 2>/dev/null && pwd -P) || return 1
        resolve_candidate=$resolve_directory/$resolve_basename
    done
    [ -f "$resolve_candidate" ] && [ -x "$resolve_candidate" ] || return 1
    resolved_node=$resolve_candidate
}

old_ifs=$IFS
IFS=:
for entry in ${PATH-}; do
    case "$entry" in
        /*) ;;
        *) continue ;;
    esac
    canonical_entry=$(CDPATH= cd "$entry" 2>/dev/null && pwd -P) || continue
    candidate=$canonical_entry/node
    resolved_node=
    resolve_node_candidate "$candidate" || continue
    case "$resolved_node" in
		"$excluded_root"/*) continue ;;
	esac
    node_path=$resolved_node
    break
done
IFS=$old_ifs
if [ -z "$node_path" ]; then
    echo "No trusted absolute node executable was found outside the active worktree." >&2
    exit 1
fi

exec "$node_path" "$script_path"
