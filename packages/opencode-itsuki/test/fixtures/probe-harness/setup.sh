#!/bin/bash
# Probe distro setup — runs inside the disposable itsuki-probe WSL distro as root.
set -e
export DEBIAN_FRONTEND=noninteractive
mkdir -p /root/probe/logs /root/probe/project/.opencode/plugin /root/probe/bin
echo "== apt =="
apt-get update -q 2>&1 | tail -1
apt-get install -y -q nodejs npm curl ca-certificates 2>&1 | tail -1
node --version; npm --version
echo "== opencode binary =="
cd /root/probe/bin
curl -sL -o oc.tgz "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.18.18.tgz"
tar -xzf oc.tgz
chmod +x package/bin/opencode
./package/bin/opencode --version
echo "== payload =="
cp /mnt/c/Users/ziyad/uml/tmp/probes/wsl/payload/probe-plugin.ts /root/probe/project/.opencode/plugin/probe.ts
cp /mnt/c/Users/ziyad/uml/tmp/probes/wsl/payload/opencode.json /root/probe/project/opencode.json
cp /mnt/c/Users/ziyad/uml/tmp/probes/wsl/payload/stub-llm.mjs /root/probe/stub-llm.mjs
echo "== sdk for driver =="
cd /root/probe
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund @opencode-ai/sdk@1.18.18 2>&1 | tail -1
echo "SETUP OK"
