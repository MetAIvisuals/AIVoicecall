# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand
- Anruf + Stream funktionieren. Whisper scheitert mit `ECONNRESET` beim Upload zu api.openai.com.
- Gefixt: 16 kHz PCM WAV, Upload aus dem Speicher, Queue (max. 2), `/audio`-Route eingebunden, OpenAI-SDK v7 (natives fetch), `[SELFTEST]` beim Start (GET /v1/models).
- Noch nicht verifiziert, ob SDK v7 das ECONNRESET behebt. Evtl. kein OpenAI-Guthaben (SELFTEST zeigt 429).

## Bekanntes Designproblem
`<Dial>` verbindet beide Telefone direkt -> beide hören immer das Original. `calls().update()` zum Einspielen ersetzt das TwiML und trennt wahrscheinlich den Dial.
Plan: pro Teilnehmer bidirektionaler `<Connect><Stream>` (oder Konferenz) + OpenAI Realtime API (g711 μ-law rein/raus) statt Whisper/GPT/ElevenLabs.

## Ablauf (aktuell)
Twilio `/call/inbound` -> WS `/media-stream` (`src/routes/stream.js`, 5-s-Flush) -> `whisper.js` -> `translate.js` -> `elevenlabs.js` -> `twilioClient.js`
