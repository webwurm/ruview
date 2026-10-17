# RuView-Demo: Wer ist wo in der Wohnung?

Experimente mit [RuView](https://github.com/ruvnet/RuView): Anwesenheit und Bewegung
in der Wohnung über WLAN-Kanaldaten (CSI) von ESP32-S3-Sensoren erkennen und in einer
eigenen Web-Oberfläche auf einem Grundriss anzeigen.

## Plan

1. **RuView auf dem OMV-Server starten** (zuerst mit simulierten Daten) und die API kennenlernen.
2. **Einen ESP32-S3 anbinden** und in einem Raum testen.
3. **Eigene Web-Demo** mit Wohnungsgrundriss bauen, als zweiter Container.
4. **Auf 3+ Sensoren ausbauen** und die Genauigkeit ehrlich messen.

## Schritt 1: RuView in OpenMediaVault starten

1. In OMV unter *Services → Compose → Files* eine neue Datei anlegen und den Inhalt von
   [`docker-compose.yml`](docker-compose.yml) einfügen.
2. Ins Feld *Environment* den Inhalt von [`.env.example`](.env.example) kopieren und anpassen:
   - `RUVIEW_API_TOKEN`: langer Zufallswert, z. B. `openssl rand -hex 32`
   - `SERVER_IP`: IP-Adresse des OMV-Servers
   - `LAN_SUBNET`: dein Heimnetz, z. B. `192.168.1.0/24`
3. Starten und `http://<SERVER_IP>:3000/ui/index.html` öffnen. Den Token einmal unter
   *Settings → API Access* eintragen.

Wichtig (laut RuView-Doku):
- Ohne `RUVIEW_API_TOKEN` startet der Container nicht (Exit-Code 64).
- Ohne `SENSING_ALLOWED_HOSTS` antwortet der Server Zugriffen von anderen Rechnern mit 421.
- Ohne Sensor muss `CSI_SOURCE=simulated` gesetzt sein, sonst bricht er ab.

Nützliche API-Aufrufe:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<SERVER_IP>:3000/api/v1/sensing/latest
curl -H "Authorization: Bearer $TOKEN" http://<SERVER_IP>:3000/api/v1/nodes
# Live-Stream per WebSocket: ws://<SERVER_IP>:3000/ws/sensing
```

## Grenzen

- Ein einzelner Sensor erkennt vor allem Anwesenheit und Bewegung entlang einer Funkstrecke.
  Für Positionen braucht es 3 oder mehr räumlich verteilte Sensoren plus Kalibrierung.
- Personen namentlich zu unterscheiden ist laut RuView mit WLAN allein derzeit nicht möglich.
- ESP32-C3 wird von der RuView-Firmware nicht unterstützt (nur ESP32-S3 und ESP32-C6).
