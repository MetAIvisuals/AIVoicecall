# Handover

**Status:** Pipeline läuft bis Whisper. Transkription scheitert auf Railway mit `Connection error.`

## Ablauf
Caller -> Twilio `/call/inbound` (TwiML Start/Stream + Dial) -> WebSocket `/media-stream`
-> `src/routes/stream.js` (Sprach-Erkennung, alle 5 s Flush) -> `whisper.js` -> `translate.js` -> `elevenlabs.js` -> `twilioClient.js` (Audio in Call einspielen)

## Offenes Problem
Whisper-Aufruf (OpenAI) schlägt auf Railway fehl. Ursachen-Kandidaten: API-Key/Netz auf Railway, Audioformat (8 kHz mulaw WAV), zu viele parallele Requests.

## Nächste Schritte
1. OpenAI-Erreichbarkeit von Railway aus testen (Fehlerdetails in `whisper.js` loggen: err.cause, err.status)
2. Requests queuen (max. 2 parallel)
3. Falls nötig: Audio nach 16 kHz PCM WAV wandeln
4. Danach: Sprachauswahl per Tastatur (IVR) vor der Verbindung

## Deployment
Railway, Variablen siehe `.env.example`. Twilio-Webhooks: `POST {SERVER_URL}/call/inbound` und `/call/status`.
