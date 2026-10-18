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
   - `RUVIEW_API_TOKEN`: langer Zufallswert, z. B. `openssl rand -hex 32`. Nur Buchstaben a-z/A-Z und Ziffern, keine Umlaute (sonst lehnt der Server den Token aus dem Browser ab).
   - `SERVER_IP`: IP-Adresse des OMV-Servers
   - `RUVIEW_PORT`: Port am Server, Standard `3080`
   - `LAN_SUBNET`: dein Heimnetz, z. B. `192.168.1.0/24`
3. Starten und `http://<SERVER_IP>:3080/ui/index.html` öffnen. Den Token einmal unter
   *Settings → API Access* eintragen.

Wichtig (laut RuView-Doku):
- Ohne `RUVIEW_API_TOKEN` startet der Container nicht (Exit-Code 64).
- Ohne `SENSING_ALLOWED_HOSTS` antwortet der Server Zugriffen von anderen Rechnern mit 421.
- Ohne Sensor muss `CSI_SOURCE=simulated` gesetzt sein, sonst bricht er ab.

Nützliche API-Aufrufe:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<SERVER_IP>:3080/api/v1/sensing/latest
curl -H "Authorization: Bearer $TOKEN" http://<SERVER_IP>:3080/api/v1/nodes
# Live-Stream per WebSocket: ws://<SERVER_IP>:3080/ws/sensing
```

## Schritt 3: Demo „Wer ist wo“

Die Compose-Datei startet neben RuView einen zweiten Container `demo`, den OMV direkt aus
dem Ordner [`web/`](web/) dieses Repos baut (dafür muss `git` auf dem Server installiert sein: `apt install git`). Danach `http://<SERVER_IP>:3090/` öffnen.

- Zeigt Personen auf dem Grundriss, zählt sie pro Raum und blendet auf Wunsch die
  RuView-Signalkarte und Bewegungsspuren ein.
- Der Browser braucht keinen Token: Der Demo-Container reicht nur lesende API-Aufrufe
  (GET) an RuView weiter und hängt den Token selbst an.
- Eigener Grundriss: Er gehört nicht ins Repo. Lege ihn auf dem Server als
  `demo-config/floorplan.json` neben die Compose-Datei; der Ordner wird in den Container
  eingebunden. Den Ordner findest du mit
  `docker inspect ruview --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'`.
  Format wie die Beispielwohnung in [`web/public/floorplan.json`](web/public/floorplan.json):
  alle Angaben in Metern, Räume als Polygone, `ruview_origin` legt fest, wo RuViews Nullpunkt
  im Grundriss liegt. Nach einer Änderung reicht ein Neuladen im Browser.
- Ohne Server ausprobieren: `web/public/` mit einem beliebigen Webserver ausliefern und
  `index.html?mock` öffnen (z. B. `cd web/public && python3 -m http.server`).

### Was die API liefert (`/api/v1/sensing/latest`)

| Feld | Bedeutung |
|---|---|
| `classification` | `presence`, `motion_level` (`absent`, `present_still`, `present_moving`, `active`), `confidence` |
| `estimated_persons` | geschätzte Personenzahl |
| `persons[].position` | `[x, y, z]` in Metern, `x`/`z` horizontal, Nullpunkt = Mitte der Signalkarte |
| `signal_field` | 20×20-Raster, Zelle = 0,6 m × 0,5 m |
| `nodes[]` | Sensoren mit Position und RSSI |
| `features` | Rohmerkmale: RSSI, Bewegungs- und Atemband-Energie, Varianz |

Beobachtungen im RuView-Quellcode: Die Signalkarte ordnet jedem Subträger einen *Winkel*
zu, nicht einen gemessenen Ort, und die Personenpositionen sind die Spitzen dieser Karte.
Mit einem Sensor sind die Positionen daher eher Visualisierung als Ortung. Personen-IDs
wechseln häufig, und `estimated_persons` passt oft nicht zur Länge von `persons`.

## Grenzen

- Ein einzelner Sensor erkennt vor allem Anwesenheit und Bewegung entlang einer Funkstrecke.
  Für Positionen braucht es 3 oder mehr räumlich verteilte Sensoren plus Kalibrierung.
- Personen namentlich zu unterscheiden ist laut RuView mit WLAN allein derzeit nicht möglich.
- ESP32 (klassisch) und ESP32-C3 werden von RuView offiziell nicht unterstützt; [`firmware/`](firmware/) baut die Firmware experimentell auch für diese Chips.
