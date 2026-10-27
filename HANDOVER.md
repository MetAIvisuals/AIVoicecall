# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand (27.10.)
- OpenAI-Guthaben war leer (429) – aufgeladen.
- Umbau: kein <Dial> mehr. Anrufer und Angerufener haben je einen eigenen bidirektionalen <Connect><Stream>; der Server ruft das Ziel per REST an.
- Übersetzung pro Richtung über OpenAI Realtime API (`src/services/realtimeTranslator.js`, g711 μ-law rein/raus, server VAD). Jede Seite hört nur die Übersetzung.
- Whisper/GPT/ElevenLabs-Dateien liegen noch da, werden aber nicht mehr benutzt.
- Optional: Env `OPENAI_REALTIME_MODEL` (Standard gpt-realtime), `OPENAI_REALTIME_VOICE` (Standard marin).
- Noch nicht mit echtem Anruf getestet.

## Ablauf
Twilio `/call/inbound` -> TwiML Connect/Stream (role=caller) + REST-Anruf zum Ziel (role=callee) -> WS `/media-stream` (`src/routes/stream.js` paart beide über pairId) -> Realtime EN->DE bzw. DE->EN -> Audio zur jeweils anderen Seite.
