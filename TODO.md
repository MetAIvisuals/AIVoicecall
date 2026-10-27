# TODO

- [ ] Whisper "Connection error" auf Railway verifizieren (Diagnose-Logs + 16 kHz PCM + Retries eingebaut; Logs prüfen auf `[WHISPER] Cause:`)
- [x] Requests queuen (max. 2 parallel) — in whisper.js
- [ ] Ende-zu-Ende-Test mit zwei Telefonen (EN gesprochen -> DE gehört)
- [ ] Rückrichtung: Antwort des Angerufenen (DE) als englischer Text für den Anrufer
- [ ] Redis statt In-Memory-Sessions
- [ ] Kostenlimit für OpenAI/ElevenLabs
- [ ] ALLOWED_CALLERS in Railway setzen
- [ ] Menü-Ansagen in der gewählten Sprache
- [ ] Echo-Sperre testen (ECHO_TAIL_MS, Standard 400 ms); Nachteil: man kann die laufende Übersetzung nicht unterbrechen
