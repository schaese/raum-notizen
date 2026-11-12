# Raum-Notizen (Spatial Notes) - WebXR Prototype

WebXR-Prototyp "Raum-Notizen" für Android-Chrome.

## Features
- AR-Session starten (`immersive-ar` mit `hit-test`, `anchors`, `dom-overlay`)
- Pin setzen per Tippen auf erkannte Fläche
- Textnotiz an Pin anhängen (3D-Canvas Texture)
- 3D-Zeichnen mit dem Finger im Raum
- XR-Anchors Bindung
- Tracking-Verlust Warnung
- Fallback-Seite für Geräte ohne WebXR

## Start-Anleitung
```bash
cd ~/projekte/raum-notizen
chmod +x start.sh
./start.sh
```

## Git Setup
```bash
git remote add origin <URL>
git push -u origin main
```
