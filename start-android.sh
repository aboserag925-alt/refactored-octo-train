#!/usr/bin/env bash
# تشغيل أبو سراج (بعد التثبيت): bash start-android.sh
cd "$(dirname "$0")"
[ -f .env ] || { echo "مفيش .env. شغّل الأول: bash install-android.sh"; exit 1; }
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
( sleep 3; command -v termux-open-url >/dev/null 2>&1 && termux-open-url "http://localhost:3000" ) >/dev/null 2>&1 &
echo "أبو سراج شغال على http://localhost:3000  (سيب Termux مفتوح، وCtrl+C للإيقاف)"
exec node server.js
