# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand (27.10., Teil 4)
- Wunsch: kein Original hörbar, immer dieselbe KI-Stimme, auch bei gleicher Sprache; Anrufer-Sprache automatisch.
- gpt-realtime-translate kann das nicht (bleibt bei gleicher Sprache stumm, keine feste Stimme) -> ersetzt.
- Neue Kette pro Seite: `transcriber.js` (Realtime-Transkription, gpt-4o-transcribe, server VAD 500 ms, μ-law direkt) -> `interpreter.js` (gpt-4o-mini: Sprache erkennen + übersetzen, gleiche Sprache bleibt) -> `tts.js` (gpt-4o-mini-tts, Stimme coral, PCM 24 kHz -> 8 kHz) -> nur die andere Seite hört die KI-Stimme.
- Anrufer-Sprache wird aus seinen Sätzen erkannt (`session.callerLang`), Rückrichtung geht in diese Sprache (Standard bis dahin: CALLER_LANG / en).
- Menü: nur noch Zielsprache (1-9) + Nummer.
- Env optional: TRANSCRIBE_MODEL, TRANSLATE_MODEL, TTS_MODEL, TTS_VOICE, VAD_SILENCE_MS, NOISE_GATE_RMS, MAX_BACKLOG_MS.
- Log: `[caller] (lang) "..." -> (de) "..."`, `[LAT ...]` = Satzende bis KI-Stimme.
- Noch nicht mit echtem Anruf getestet. Falls die Transkription mit Fehler startet: Session-Format in `transcriber.js` prüfen (GA vs. beta-Fallback).

## Ablauf
Twilio `/call/inbound` -> TwiML Connect/Stream (role=caller) + REST-Anruf zum Ziel (role=callee) -> WS `/media-stream` (`src/routes/stream.js` paart beide über pairId) -> Realtime EN->DE bzw. DE->EN -> Audio zur jeweils anderen Seite.
