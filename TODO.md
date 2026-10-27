# TODO

- [x] Whisper-ECONNRESET: war fehlendes OpenAI-Guthaben (429), Kette inzwischen ersetzt
- [x] Requests queuen (max. 2 parallel) — in whisper.js (Pfad entfällt)
- [ ] Realtime-Pfad (`REALTIME=1`) mit echtem Anruf testen: antwortet er statt zu übersetzen? Bleibt er bei gleicher Sprache stumm?
- [ ] Latenz beider Pfade aus den `[LAT]`-Logs vergleichen, dann einen Pfad verwerfen
- [ ] Unterbrechen im Realtime-Pfad (`response.cancel` + Twilio `clear`), wenn der Zuhörer dazwischenredet
- [ ] Alte Kette entfernen (`whisper.js`, `translate.js`, `elevenlabs.js`), sobald ein Pfad gewonnen hat
- [ ] Ende-zu-Ende-Test mit zwei Telefonen (EN gesprochen -> DE gehört)
- [ ] Redis statt In-Memory-Sessions
- [ ] Kostenlimit für OpenAI/ElevenLabs
- [ ] ALLOWED_CALLERS in Railway setzen
- [ ] Menü-Ansagen in der gewählten Sprache
