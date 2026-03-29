# 📞 Call Translator

> Real-time phone call translation using Twilio, Whisper, GPT-4 and ElevenLabs.  
> Someone calls your number speaking English — the German party hears it in German. No app needed on either side.

![CI](https://github.com/YOUR_USERNAME/call-translator/actions/workflows/ci.yml/badge.svg)

## How it works

```
You (English)  ──dial──▶  Twilio number
                               │
                    Media Stream WebSocket
                               │
                         ┌─────▼─────┐
                         │  Whisper  │  transcribe speech → text
                         └─────┬─────┘
                               │
                         ┌─────▼─────┐
                         │  GPT-4o   │  translate to German
                         └─────┬─────┘
                               │
                         ┌─────▼──────────┐
                         │  ElevenLabs    │  stream TTS audio
                         │  /stream API   │  (early resolve at 8KB)
                         └─────┬──────────┘
                               │
                    Twilio injects audio into call
                               │
                    German party hears German  🇩🇪
```

**Latency:** ~1.5–2.5s end-to-end (Whisper ~400ms + GPT ~200ms + ElevenLabs streaming ~300ms first chunk).

## Features

- 🎙 Speak naturally — silence detection triggers translation automatically
- ⚡ Streaming TTS — ElevenLabs starts playing before synthesis is complete
- 💾 Audio cache — repeated phrases skip the API entirely
- 🌍 12 languages supported (set via env vars)
- 📊 Live dashboard at `localhost:3000`
- 🐳 Docker ready
- 🔁 GitHub Actions CI

## Quick start

### Prerequisites

- Node.js 20+
- A [Twilio](https://twilio.com) account with a phone number
- [OpenAI](https://platform.openai.com) API key
- [ElevenLabs](https://elevenlabs.io) API key
- [ngrok](https://ngrok.com) (for local dev)

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/call-translator.git
cd call-translator
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to find it |
|---|---|
| `TWILIO_ACCOUNT_SID` | [Twilio Console](https://console.twilio.com) → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Twilio Console → Phone Numbers |
| `DEFAULT_TARGET_NUMBER` | The German number you want to call |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ELEVENLABS_API_KEY` | [elevenlabs.io/app/settings](https://elevenlabs.io/app/settings) |
| `SERVER_URL` | Your public URL (see step 3) |

### 3. Expose your server publicly

```bash
# Terminal 1 — start the server
npm run dev

# Terminal 2 — start ngrok tunnel
npm run tunnel
```

Copy the `https://xxxx.ngrok.io` URL → paste as `SERVER_URL` in `.env`.

### 4. Configure Twilio webhook

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers → your number
2. Under **Voice Configuration**, set:
   - **"A call comes in"** → `POST https://YOUR_NGROK_URL/call/inbound`
   - **Status Callback** → `POST https://YOUR_NGROK_URL/call/status`
3. Save

### 5. Make a call

Call your Twilio number. It will bridge to `DEFAULT_TARGET_NUMBER` with live translation.  
Open `http://localhost:3000` to watch the live transcript.

## Docker

```bash
docker compose up
```

## Configuration reference

```bash
SERVER_URL=https://xxxx.ngrok.io
PORT=3000
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
DEFAULT_TARGET_NUMBER=+49XXXXXXXXXX
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=xxx
ELEVENLABS_VOICE_DE=pNInz6obpgDQGcFmaJgB   # optional
CALLER_LANG=en
TARGET_LANG=de
```

## Supported languages

`en` `de` `fr` `es` `it` `pt` `nl` `pl` `ru` `ar` `zh` `ja`

## Project structure

```
call-translator/
├── src/
│   ├── server.js              # Express + WebSocket server
│   ├── routes/
│   │   ├── call.js            # Twilio inbound call webhook (TwiML)
│   │   ├── stream.js          # Media Stream WebSocket + pipeline
│   │   └── audio.js           # Serves cached audio files to Twilio
│   └── services/
│       ├── whisper.js         # Speech-to-text (OpenAI Whisper)
│       ├── translate.js       # Translation (GPT-4o-mini)
│       ├── elevenlabs.js      # Streaming TTS (ElevenLabs)
│       ├── twilioClient.js    # Injects audio into live call
│       └── sessionStore.js    # In-memory call session state
├── public/
│   └── index.html             # Live dashboard
├── audio_cache/               # Cached MP3s (gitignored)
├── .github/workflows/ci.yml   # GitHub Actions CI
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Production notes

- Replace `sessionStore.js` with **Redis** for multi-instance deployments
- Mount `audio_cache/` as a persistent volume (done in `docker-compose.yml`)
- Add **bidirectional translation** — currently caller → target only
- Consider **Deepgram** for lower-latency streaming transcription

## License

MIT
