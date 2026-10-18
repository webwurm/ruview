#!/usr/bin/env bash
# Baut die RuView-CSI-Firmware für Chips, die RuView offiziell nicht unterstützt:
# klassischer ESP32 (z. B. ESP32-WROOM-32D) und ESP32-C3.
#
# Ablauf: RuView und die led_strip-Komponente in festen Versionen holen, die
# Anpassungen aus diesem Ordner anwenden, mit dem ESP-IDF-Docker-Image bauen und
# pro Chip ein einzelnes Flash-Image nach dist/ schreiben.
#
# Aufruf: ./build.sh            (beide Chips)
#         ./build.sh esp32      (nur einer)
set -euo pipefail

RUVIEW_COMMIT=a1ca023ee872683d160250d47ae3d4d228af55a0
# Letzter Stand von led_strip 3.0.3; 3.1 braucht ESP-IDF 5.5.
IDF_EXTRA_COMMIT=77d9f2218748db20ee87fc259d0072d517f1a838
IDF_IMAGE=espressif/idf:v5.4.2

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HERE/.work}
TARGETS=${*:-esp32 esp32c3}

mkdir -p "$WORK" "$HERE/dist"

if [ ! -d "$WORK/RuView" ]; then
  git clone --filter=blob:none --sparse https://github.com/ruvnet/RuView.git "$WORK/RuView"
  git -C "$WORK/RuView" sparse-checkout set firmware/esp32-csi-node
fi
git -C "$WORK/RuView" checkout -q "$RUVIEW_COMMIT"

if [ ! -d "$WORK/idf-extra-components" ]; then
  git clone --filter=blob:none --sparse https://github.com/espressif/idf-extra-components.git "$WORK/idf-extra-components"
  git -C "$WORK/idf-extra-components" sparse-checkout set led_strip
fi
git -C "$WORK/idf-extra-components" checkout -q "$IDF_EXTRA_COMMIT"

for t in $TARGETS; do
  src="$WORK/build-$t"
  rm -rf "$src"
  cp -r "$WORK/RuView/firmware/esp32-csi-node" "$src"
  rm -f "$src/sdkconfig" "$src/dependencies.lock"

  # Display (LVGL) und Komponenten-Registry werden nicht gebraucht; led_strip liegt lokal.
  printf 'dependencies: {}\n' > "$src/main/idf_component.yml"
  cp -r "$WORK/idf-extra-components/led_strip" "$src/components/led_strip"
  cp "$HERE/sdkconfig.defaults.$t" "$src/"
  for p in "$HERE"/patches/*.patch; do patch -s -p1 -d "$src" < "$p"; done

  docker run --rm -v "$src":/project -w /project "$IDF_IMAGE" bash -c "
    idf.py set-target $t >/dev/null &&
    idf.py build &&
    cd build && esptool.py --chip $t merge_bin -o /project/merged.bin @flash_args"
  cp "$src/merged.bin" "$HERE/dist/ruview-$t.bin"
  echo "Fertig: dist/ruview-$t.bin"
done
