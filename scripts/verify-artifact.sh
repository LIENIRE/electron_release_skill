#!/usr/bin/env bash
# verify-artifact.sh —— 产物验证：签名 / 公证 / staple / 清单完整性 / 线上更新源
#
# 用法：
#   verify-artifact.sh <dmg|app|zip 路径># 验单个 .app 或 .dmg 的签名与公证
#   verify-artifact.sh --manifest <latest*.yml> --dir <产物目录>   # 验清单与产物配对
#   verify-artifact.sh --feed <更新源 URL> [期望版本]     # 验线上更新源 + 诊断不可达原因
#
# 退出码：0 通过；1 验失败；2 参数错误
set -uo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok(){ printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
bad(){ printf '%s✗%s %s\n' "$RED" "$RST" "$*"; }
warn(){ printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
dim(){ printf '%s%s%s\n' "$DIM" "$*" "$RST"; }
die(){ bad "$*"; exit 2; }

[ $# -ge 1 ] || die "用法: $0 <dmg|app> | --manifest <yml> --dir <dir> | --feed <url> [version]"

# ---------- 模式三：线上更新源可达性 + 版本一致性 + 不可达根因诊断 ----------
if [ "$1" = "--feed" ]; then
  FEED="${2:-}"; EXPECT="${3:-}"
  [ -n "$FEED" ] || die "需要 --feed <更新源 URL>（通常以 / 结尾）"
  case "$FEED" in */) ;; *) FEED="$FEED/";; esac

  echo "── 更新源可达性 ──"
  dim "  $FEED"

  # 走代理（默认）
  CODE=$(curl -s -o /tmp/_feed.out -w "%{http_code}" --max-time 20 "${FEED}latest-mac.yml" 2>/dev/null || echo 000)
  VIA=$(curl -s -o /dev/null -w "%{remote_ip}" --max-time 20 "${FEED}latest-mac.yml" 2>/dev/null || echo "-")

  # 绕过本地代理再试一次，用于区分「服务器真404」与「代理劫持」
  CODE2=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" --max-time 20 "${FEED}latest-mac.yml" 2>/dev/null || echo 000)

  if [ "$CODE" = "200" ]; then
    ok "清单可访问（HTTP ${CODE}，出口 ${VIA}）"
  else
    warn "清单不可访问（HTTP ${CODE}，出口 ${VIA}；绕过代理后 HTTP ${CODE2}）"
    #根因判定
    RESOLVED=$(dig +short "$(echo "$FEED" | sed -E 's#https?://([^/]+)/?.*#\1#')" 2>/dev/null | head -1)
    if [[ "${RESOLVED:-}" == 198.18.* || "${RESOLVED:-}" == 198.19.* ]]; then
      warn "域名解析到 ${RESOLVED} —— 落在 RFC 2544 基准测试保留段，是 Clash/mihomo 的 fake-IP 池"
      dim "这是本地代理的 DNS 劫持，不代表真实服务器地址。"
      dim "  处理：① 确认代理对该域名的规则（可能走了错误分流）"
      dim "        ② 若代理不可用，直连时在配置里填真实服务器 IP"
    fi
    if [ "$CODE" = "$CODE2" ]; then
      bad "代理与直连结果一致（均 ${CODE}）→ 服务器侧确实没有该文件，不是代理问题"
      dim "  处理：① 确认部署目录是否真的存在该文件（ssh 上 ls 一下）"
      dim "        ② 确认 web server 的 root/alias 是否指向部署目录（nginx server block）"
      dim "        ③ 确认清单文件名与 publish.url 拼接结果一致（latest-mac.yml / latest.yml）"
    else
      bad "代理($CODE) 与直连($CODE2) 结果不同 → 本地代理干扰，需绕过或修规则"
    fi
    echo
    echo "  根目录可达性对照（帮助判断是目录问题还是文件问题）："
    for path in "/" "/latest-mac.yml"; do
      c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "${FEED%/}$path" 2>/dev/null || echo 000)
      dim  "    $c  ${FEED%/}$path"
    done
    exit 1
  fi

  LIVEVER=$(grep -m1 '^version:' /tmp/_feed.out 2>/dev/null | sed 's/^version:[[:space:]]*//' | tr -d "'\"\r" || true)
  if [ -n "$LIVEVER" ]; then
    ok "线上版本 = ${LIVEVER:-未知}"
  else
    warn "清单里读不到 version 字段（可能返回的不是 YAML，是 HTML 错误页）"
    head -3 /tmp/_feed.out | dim
  fi
  if [ -n "$EXPECT" ]; then
    if [ "$LIVEVER" = "$EXPECT" ]; then
      ok "与期望版本 ${EXPECT} 一致"
    else
      bad "线上版本 ${LIVEVER:-未知} ≠ 期望 ${EXPECT} —— 客户端不会升级到本次版本"
    fi
  fi

  # 安装包托管位置
  echo "── 清单内容 ──"
  if grep -q 'url: https\?://' /tmp/_feed.out 2>/dev/null; then
    ok "安装包使用绝对地址（清单与包不在同一处）"
    grep -o 'url: https\?://[^ ]*' /tmp/_feed.out | head -4 | dim
  else
    warn "清单 url 为相对路径 —— 安装包必须与清单同目录托管"
  fi
  exit 0
fi

# ---------- 模式一：校验清单与产物配对 ----------
if [ "$1" = "--manifest" ]; then
  MANIFEST="${2:-}"; DIR="${4:-}"
  [ -f "$MANIFEST" ] || die "清单不存在: $MANIFEST"
  [ -n "$DIR" ] || die "需要 --dir <产物目录>"
  [ -d "$DIR" ] || die "产物目录不存在: $DIR"
  # 后续子进程会切换工作目录（为require 项目 js-yaml），先固化为绝对路径
  MANIFEST="$(cd "$(dirname "$MANIFEST")" && pwd)/$(basename "$MANIFEST")"
  DIR="$(cd "$DIR" && pwd)"
  PROJECT_ROOT="$(dirname "$DIR")"

  dim "校验清单 $MANIFEST 与目录 $DIR 的配对"
  # 用 Python 校验（需 pyyaml）；没装则回退到 node +项目自带的 js-yaml
  # 说明：Electron 项目几乎都装了 js-yaml（electron-builder 依赖），故优先 node
  if command -v node >/dev/null 2>&1 && NODE_MOD=$(cd "$DIR/.." 2>/dev/null && node -e 'require.resolve("js-yaml");console.log("ok ")' 2>/dev/null) && [ "$NODE_MOD" = "ok " ]; then
    dim "  （使用 node + js-yaml 校验）"
    ( cd "$DIR/.." && node -e '
      const fs=require("fs"),path=require("path"),crypto=require("crypto"),yaml=require("js-yaml");
      const mp=process.argv[1],dp=process.argv[2];
      const m=yaml.load(fs.readFileSync(mp,"utf8"));
      if(!m||!Array.isArray(m.files)||!m.files.length){console.log("✗ 清单缺少 files 数组");process.exit(1);}
      let fail=0;
      for(let i=0;i<m.files.length;i++){
        const f=m.files[i];
        for(const k of ["url","sha512","size"]){
          if(!f[k]){console.log(`✗ files[${i}] 缺少 ${k}`);fail=1;}
        }
        if(!f.url) continue;
        const name=path.basename(f.url), p=path.join(dp,name);
        if(!fs.existsSync(p)){console.log(`✗ ${name} 产物缺失`);fail=1;continue;}
        const b=fs.readFileSync(p);
        if(b.length!==f.size){console.log(`✗ ${name} 实际 ${b.length} 字节 ≠ 清单 ${f.size}`);fail=1;continue;}
        const h=crypto.createHash("sha512").update(b).digest("base64");
        if(h!==f.sha512){console.log(`✗ ${name} sha512 与清单不一致`);fail=1;continue;}
        console.log(`✓ ${name}  ${Math.round(b.length/1048576)}MB  sha512 匹配`);
      }
      if(m.path){const pn=path.basename(m.path);if(!fs.existsSync(path.join(dp,pn)))console.log(`! path 字段指向的主产物不在目录: ${pn}`);}
      process.exit(fail);
    ' "$MANIFEST" "$DIR" )
    exit $?
  elif command -v python3 >/dev/null && python3 -c 'import yaml' 2>/dev/null; then
    python3 - "$MANIFEST" "$DIR" <<'PY'
import sys,os,hashlib,base64,yaml
mp,dp=sys.argv[1],sys.argv[2]
m=yaml.safe_load(open(mp,encoding='utf8'))
if not isinstance(m,dict) or not isinstance(m.get('files'),list) or not m['files']:
    print('✗ 清单缺少 files 数组'); sys.exit(1)
fail=0
for i,f in enumerate(m['files']):
    for k in ('url','sha512','size'):
        if not f.get(k):
            print(f'✗ files[{i}] 缺少 {k}'); fail=1
    if fail: continue
    name=os.path.basename(f['url']); p=os.path.join(dp,name)
    if not os.path.isfile(p):
        print(f'✗ {name} 产物缺失'); fail=1; continue
    b=open(p,'rb').read()
    if len(b)!=f['size']:
        print(f'✗ {name} 实际 {len(b)} 字节 ≠ 清单 {f["size"]}'); fail=1; continue
    h=base64.b64encode(hashlib.sha512(b).digest()).decode()
    if h!=f['sha512']:
        print(f'✗ {name} sha512 与清单不一致'); fail=1; continue
    print(f'✓ {name}  {len(b)//1048576}MB  sha512 匹配')
if m.get('path'):
    pn=os.path.basename(m['path'])
    if not os.path.isfile(os.path.join(dp,pn)):
        print(f'! path 字段指向的主产物不在目录: {pn}')
sys.exit(fail)
PY
    exit $?
  else
    bad "无 YAML 解析能力：项目未安装 js-yaml，系统Python 也无 pyyaml"
    dim "  解决：npm i -D js-yaml  或  pip3 install pyyaml"
    exit 1
  fi
fi

# ---------- 模式二：校验单个 .app / .dmg 的签名与公证 ----------
TARGET="$1"
[ -e "$TARGET" ] || die "路径不存在: $TARGET"

if [ "${OS:-$(uname -s)}" != "Darwin" ]; then
  warn "非 macOS，无法校验 Apple 签名/公证；Windows 签名请用 signtool verify"
  exit 0
fi

fail=0

# dmg 需挂载才能取到 .app；用临时目录 + hdiutil，退出时卸载
MOUNT_DIR=""
cleanup(){
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet -force >/dev/null 2>&1 || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$TARGET" == *.dmg ]]; then
  MOUNT_DIR=$(mktemp -d /tmp/_verify_dmg.XXXXXX) || die "无法创建临时挂载点"
  dim "挂载 $TARGET ..."
  if ! hdiutil attach "$TARGET" -nobrowse -readonly -quiet -mountpoint "$MOUNT_DIR" 2>/dev/null; then
    bad "dmg 挂载失败（文件损坏或已被系统占用）"
    exit 1
  fi
  APP_IN_DMG=$(find "$MOUNT_DIR" -maxdepth 2 -name '*.app' 2>/dev/null | head -1)
  if [ -z "$APP_IN_DMG" ]; then
    bad "dmg 内未找到 .app"
    exit 1
  fi
  TARGET="$APP_IN_DMG"
fi

# 已经是 .app 就直接验；若是目录且内含 .app 也接受
if [ -d "$TARGET" ] && [[ "$TARGET" != *.app ]]; then
  APP_IN=$(find "$TARGET" -maxdepth 2 -name '*.app' 2>/dev/null | head -1)
  [ -n "$APP_IN" ] && TARGET="$APP_IN"
fi

echo "── 签名 ──"
SIG_OUT=$(codesign -dv --verbose=4 "$TARGET" 2>&1) || true
AUTHORITY=$(grep -o 'Authority=[^ ]*' <<<"$SIG_OUT" | tail -1 | cut -d= -f2)
SIGNED=$(grep -q 'Signature=adhoc' <<<"$SIG_OUT" && echo adhoc || echo ok)
RUNTIME=$(grep -o 'flags=[^ ]*' <<<"$SIG_OUT" | head -1)

if grep -q 'code object is not signed' <<<"$SIG_OUT"; then
  bad "未签名（Gatekeeper 会拦截，需用户手动放行）"
  fail=1
elif [ "$SIGNED" = "adhoc" ]; then
  warn "ad-hoc 签名（非 Developer ID），仅本机可用，不可分发"
  fail=1
elif echo "$AUTHORITY" | grep -qi 'Developer ID'; then
  ok "已签名 Authority=$AUTHORITY"
else
  warn "已签名但 Authority 非 Developer ID：${AUTHORITY:-未知}"
fi
dim "  $RUNTIME"

echo "── 公证 ──"
# 已挂载 dmg 内的 .app 用 -t exec（执行类型）；独立 .app 用 -t install（安装包类型）
if [[ "$TARGET" == *.app ]]; then
  SPCTL_ARGS=(-a -vvv -t exec "$TARGET")
else
  SPCTL_ARGS=(-a -vvv -t install "$TARGET")
fi
if spctl "${SPCTL_ARGS[@]}" >/tmp/_spctl.out 2>&1; then
  if grep -qi 'notarized' /tmp/_spctl.out; then
    ok "已公证并通过 Gatekeeper"
  else
    warn "通过 Gatekeeper 但提示未公证（notarized 未出现）"
  fi
  dim "$(grep -i 'accepted\|source' /tmp/_spctl.out | head -2 | tr '\n' ' ')"
else
  SP=$(cat /tmp/_spctl.out 2>/dev/null)
  if echo "$SP" | grep -qi 'rejected'; then
    bad "Gatekeeper 拒绝：$(echo "$SP" | tail -1)"
  else
    warn "Gatekeeper 未通过：$(echo "$SP" | tail -1)"
  fi
  fail=1
fi

echo "── staple（公证票据装订）──"
if xcrun stapler validate "$TARGET" >/dev/null 2>&1; then
  ok "staple 有效"
else
  warn "staple 无效或不存在（dmg 需 electron-builder 之外手动 xcrun stapler staple）"
fi

echo
[ $fail -eq 0 ] && ok "验证通过" || bad "验证未通过（详见上方 ✗ 行）"
exit $fail