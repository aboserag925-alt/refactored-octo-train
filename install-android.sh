#!/usr/bin/env bash
# تثبيت وتشغيل أبو سراج على أندرويد (Termux) بأمر واحد:  bash install-android.sh
set -e
cd "$(dirname "$0")"
say() { printf '\n== %s\n' "$*"; }

if command -v pkg >/dev/null 2>&1; then
  say "تثبيت المتطلبات (Node.js, curl, termux-api)"
  pkg update -y && pkg install -y nodejs-lts curl termux-api
fi
command -v node >/dev/null 2>&1 || { echo "Node.js مش موجود. شغّل الملف من داخل Termux."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl مش موجود: pkg install curl"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "محتاج Node.js 18 أو أحدث."; exit 1; }

if [ ! -f .env ]; then
  say "إعداد الملف .env"
  printf 'مفتاح OPENAI_API_KEY: '; read -rs KEY; echo
  [ -n "$KEY" ] || { echo "المفتاح مطلوب."; exit 1; }
  printf 'كلمة سر للتطبيق (8 حروف أو أكتر، أو Enter لتوليد واحدة): '; read -rs PASS; echo
  case "$KEY$PASS" in *[[:space:]\#\"\'\\]*) echo "المفتاح وكلمة السر لازم يكونوا من غير مسافات أو الرموز # \" ' \\"; exit 1;; esac
  if [ "${#PASS}" -lt 8 ]; then
    PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)"
    echo "كلمة السر اللي اتولّدت: $PASS   (احفظها)"
  fi
  printf 'تفعيل أدوات الهاتف (موقع / SMS / جهات اتصال، كل واحدة بموافقتك)؟ [y/N]: '; read -r PH
  PHONE=0; if [ "$PH" = "y" ] || [ "$PH" = "Y" ]; then PHONE=1; fi
  PROJECT=""; [ -f .env.example ] && PROJECT="$(grep '^OPENAI_PROJECT_ID=' .env.example | head -1 | cut -d= -f2- | tr -d '\r')"
  umask 077
  cat > .env <<ENVEOF
OPENAI_API_KEY=$KEY
OPENAI_PROJECT_ID=$PROJECT
OPENAI_MODEL=gpt-6-astra
PORT=3000
HOST=127.0.0.1
ACCESS_PASSWORD=$PASS
DAILY_LIMIT=200
ENABLE_SHELL=0
ENABLE_PHONE=$PHONE
ENVEOF
  chmod 600 .env
  if [ "$PHONE" = 1 ] && ! command -v termux-battery-status >/dev/null 2>&1; then
    echo "تنبيه: أدوات الهاتف محتاجة تطبيق Termux:API من F-Droid (شوف PHONE_SETUP_AR.md)."
  fi
fi

# اختصار اختياري لتطبيق Termux:Widget
if [ -d "$HOME" ]; then
  mkdir -p "$HOME/.shortcuts"
  printf '#!/usr/bin/env bash\nexec bash "%s/start-android.sh"\n' "$PWD" > "$HOME/.shortcuts/Abu-Siraj"
  chmod +x "$HOME/.shortcuts/Abu-Siraj" 2>/dev/null || true
fi

if [ "${NO_START:-}" = 1 ]; then echo "تم الإعداد. شغّل: bash start-android.sh"; exit 0; fi
say "تشغيل أبو سراج"
exec bash "$PWD/start-android.sh"
