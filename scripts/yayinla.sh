#!/usr/bin/env bash
# Nabız yeni sürüm yayınlama
# Kullanım: scripts/yayinla.sh 2.16.2 "Kısa sürüm notu" [--bekle]
#  1) src/app/version.json sürümünü günceller, commit + push
#  2) GitHub'da v<sürüm> sürümünü açar → GitHub Actions kurulum dosyalarını derleyip ekler
#  3) dosyalar eklenince kök version.json'u günceller → kullanıcılara güncelleme gider
# --bekle: 3. adımı yapmaz (önce Nabiz-Setup.zip'i VirusTotal'da taratıp linki sürüm notuna ekle,
#          sonra bu betiği aynı sürümle --ac ile çalıştır)
set -euo pipefail
VER="$1"; NOTES="${2:-}"; MODE="${3:-}"
REPO="Hakyolundaa/nabiz"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

if [ "$MODE" != "--ac" ]; then
  python3 - src/app/version.json "$VER" <<'EOF'
import json,sys
p,v=sys.argv[1],sys.argv[2]; d=json.load(open(p)); d['version']=v; json.dump(d,open(p,'w'),ensure_ascii=False)
EOF
  git add -A && git commit -qm "Nabız $VER" && git push -q
  gh release create "v$VER" -R "$REPO" -t "Nabız $VER" -n "$NOTES

**İndir:** Nabiz-Setup.zip → içindeki Nabiz-Setup.exe'yi çalıştır. Zaten kuruluysa Nabız kendini günceller."
  echo "Derleniyor (GitHub Actions)…"
  n=0
  for i in $(seq 1 60); do
    n=$(gh release view "v$VER" -R "$REPO" --json assets -q '.assets|length')
    [ "$n" -ge 2 ] && break; sleep 10
  done
  [ "$n" -ge 2 ] || { echo "Dosyalar eklenmedi; Actions kaydına bak."; exit 1; }
  echo "Dosyalar hazır: https://github.com/$REPO/releases/tag/v$VER"
  [ "$MODE" = "--bekle" ] && { echo "version.json güncellenmedi. VirusTotal'dan sonra: scripts/yayinla.sh $VER \"$NOTES\" --ac"; exit 0; }
fi

python3 - version.json "$VER" "$NOTES" "$REPO" <<'EOF'
import json,sys
p,v,n,r=sys.argv[1:5]; d=json.load(open(p))
d.update(version=v, notes=n, zip=f"https://github.com/{r}/releases/download/v{v}/nabiz-guncelleme.zip")
json.dump(d,open(p,'w'),ensure_ascii=False,indent=1)
EOF
git add version.json && git commit -qm "Güncelleme: $VER" && git push -q
echo "Yayınlandı: $VER (kullanıcılara 10 dk içinde gider)"
