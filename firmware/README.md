# RuView-Firmware für ESP32-WROOM-32D und ESP32-C3

RuView liefert fertige Firmware nur für ESP32-S3 und ESP32-C6. Dieser Ordner baut die
offizielle RuView-Firmware (Version 0.8.14) zusätzlich für den **klassischen ESP32**
(z. B. ESP32-WROOM-32D) und den **ESP32-C3**. Experimentell: von RuView nicht unterstützt.

## Stand

| Chip | Baut | Im Emulator getestet | Am echten Board getestet |
|---|---|---|---|
| ESP32 (WROOM-32D) | ja | ja, 40 s mit Test-CSI-Daten stabil (Kantenverarbeitung auf Kern 1) | noch nicht |
| ESP32-C3 | ja | nein | noch nicht |

Unterschiede zur S3-Firmware:
- Kein Display, keine WASM-Module (brauchen Zusatzspeicher, den diese Boards nicht haben).
- Die bunte Status-LED des S3 fehlt; die LED-Ansteuerung ist für diese Chips abgeschaltet.
- Der klassische ESP32 liefert laut RuView etwas weniger CSI-Details als der S3 (ADR-057).

Empfehlung: zuerst den **WROOM-32D** nehmen. Er hat zwei Kerne wie der S3, der C3 nur einen.

## Flashen (Linux Mint)

Einmalig einrichten:

```bash
python3 -m venv ~/esp
~/esp/bin/pip install esptool esp-idf-nvs-partition-gen
sudo usermod -aG dialout $USER     # danach einmal ab- und wieder anmelden
```

Firmware und Einrichtungs-Skript laden:

```bash
wget https://github.com/webwurm/ruview/raw/main/firmware/dist/ruview-esp32.bin
wget https://raw.githubusercontent.com/ruvnet/RuView/a1ca023ee872683d160250d47ae3d4d228af55a0/firmware/esp32-csi-node/provision.py
```

Board per USB anstecken (meist `/dev/ttyUSB0`, prüfen mit `ls /dev/ttyUSB*`), dann:

```bash
~/esp/bin/python -m esptool --chip esp32 --port /dev/ttyUSB0 -b 460800 write_flash 0x0 ruview-esp32.bin
~/esp/bin/python provision.py --port /dev/ttyUSB0 --chip esp32 \
  --ssid "DEIN-WLAN" --target-ip <SERVER_IP> --node-id 1
```

`provision.py` fragt das WLAN-Passwort ab und speichert WLAN, Server-Adresse und
Node-ID auf dem Board. Für weitere Boards `--node-id 2`, `3` usw. Beim ESP32-C3 überall
`esp32c3` statt `esp32` und die Datei `ruview-esp32c3.bin` nehmen (Port meist `/dev/ttyACM0`).

Ausgabe des Boards mitlesen: `~/esp/bin/python -m serial.tools.miniterm /dev/ttyUSB0 115200`
(beenden mit Strg+]).

## RuView auf echte Daten umstellen

In der OMV-Environment setzen und den Stack neu starten:

```
CSI_SOURCE=esp32
LAN_SUBNET=<dein Heimnetz, z. B. 192.168.0.0/24>
```

Die Demo zeigt dann oben „Live: esp32“.

## Selbst bauen

`./build.sh` (braucht Docker und git). Das Skript holt RuView und `led_strip` in festen
Versionen, wendet [`sdkconfig.defaults.*`](.) und [`patches/`](patches/) an und schreibt
die Images nach `dist/`.

Die Images in `dist/` enthalten RuView-Code unter der MIT-Lizenz, siehe [`LICENSE-RuView`](LICENSE-RuView).
