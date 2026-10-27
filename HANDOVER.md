# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand (27.10., Teil 2)
- Erster Realtime-Test lief, aber gpt-realtime plauderte selbst ("hello, how are you") und hatte Lag.
- Jetzt: `gpt-realtime-translate` (/v1/realtime/translations), nur Übersetzung, Eingabesprache wird erkannt. Audio wird 8 kHz μ-law <-> 24 kHz PCM16 umgerechnet (`realtimeTranslator.js`).
- Telefonmenü: eigene Sprache (Taste 1-9), Zielsprache (1-9), Nummer mit Ländervorwahl + #. Nur # = DEFAULT_TARGET_NUMBER.
- Optional Env `ALLOWED_CALLERS` (kommagetrennt, z. B. +43...): nur diese Nummern dürfen das Menü nutzen. Ohne Liste kann jeder Anrufer beliebige Nummern auf Twilio-Kosten anrufen.
- Noch nicht mit echtem Anruf getestet.

## Ablauf
Twilio `/call/inbound` -> TwiML Connect/Stream (role=caller) + REST-Anruf zum Ziel (role=callee) -> WS `/media-stream` (`src/routes/stream.js` paart beide über pairId) -> Realtime EN->DE bzw. DE->EN -> Audio zur jeweils anderen Seite.
