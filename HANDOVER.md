# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand (27.10., Teil 3)
- gpt-realtime-translate läuft. Log-Befund: 1. Übersetzung kam ~20 s nach "Hallo?", danach Sätze gesammelt; erfundenes "Hi, wie geht's dir?"; DE->EN-Richtung blieb stumm.
- Laut OpenAI-Doku: gleichsprachige Wörter (Hallo) werden nicht übersetzt, Modell wartet auf genug Kontext; für Telefonie wird Original-Durchleitung mit Ducking empfohlen.
- Neu (`stream.js`): Mixer pro 20-ms-Frame: Original der Gegenseite leise (PASSTHROUGH_GAIN 0.35, beim Übersetzen DUCK_GAIN 0.08) + Übersetzung; Rauschfilter (NOISE_GATE_RMS 250) vor dem Modell; Rückstau > 1,5 s -> Pausen werden übersprungen; Log `[LAT]` (Sprechbeginn -> erste Übersetzung) und `[MIX]` (Rückstau).
- Menü: Taste 1-9 eigene Sprache, 1-9 Zielsprache, Nummer ohne # (4 s), nur # = DEFAULT_TARGET_NUMBER.
- ALLOWED_CALLERS bewusst leer (Tests mit anderen Personen).
- Echo-Sperre (Mikro stumm während Wiedergabe) wurde getestet und wieder entfernt (machte alles stumm).

## Ablauf
Twilio `/call/inbound` -> TwiML Connect/Stream (role=caller) + REST-Anruf zum Ziel (role=callee) -> WS `/media-stream` (`src/routes/stream.js` paart beide über pairId) -> Realtime EN->DE bzw. DE->EN -> Audio zur jeweils anderen Seite.
