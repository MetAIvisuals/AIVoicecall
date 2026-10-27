# Handover

**Branch:** `claude/aivoicecall-cloud-setup-1d36yj` (Railway deployt diesen Branch)
**Railway-URL:** https://aivoicecall-production-696b.up.railway.app

## Stand (27.10., Teil 5)

### Zwei Pfade, per Env umschaltbar
- `REALTIME=1` -> Speech-to-Speech: pro Leg eine Realtime-Session (`realtime.js`, `gpt-realtime`), mulaw 8 kHz rein und raus, eine feste Stimme. Kein Resampling, keine seriellen Hops, Ziel ~300-500 ms.
- ohne `REALTIME` (Standard) -> die bisherige Kette `transcriber.js` -> `interpreter.js` -> `tts.js`.
- GA-Session-Form gegen die echte API verifiziert und akzeptiert: `session.type=realtime`, `output_modalities:["audio"]`, `audio.input.format={type:"audio/pcmu"}`, `audio.output={format:{type:"audio/pcmu"},voice}`. Beta-Fallback (`g711_ulaw`, flache Felder) ist als Netz drin, wird aber nicht gebraucht.
- Realtime noch nicht mit echtem Anruf getestet. Risiko laut Doku-Erfahrung: Speech-to-Speech antwortet gern statt zu übersetzen -> die Instructions in `realtime.js` verbieten das ausdrücklich und verlangen auch bei gleicher Sprache Nachsprechen statt Stille.
- Anrufer-Sprache: im Realtime-Pfad aus dem Input-Transkript (`detectLanguage`, abseits des kritischen Pfads), danach `setTargetLang` auf das andere Leg.

### Fixes an der bestehenden Kette (Teil 5)
- Erfundene Sätze abgestellt: der Interpreter-Prompt durfte "obvious transcription errors" korrigieren und bekam 4 Sätze Kontext -> aus `"Ich ka säm Stupid."` wurde `"Ich kann's nicht glauben, wie dumm ich bin."`. Jetzt strikt wörtlich, kein Kontext, leerer Text bei Unverständlichem.
- STT bekam keinen Sprach-Hinweis -> Lachen wurde als Koreanisch erkannt, die Anrufer-Sprache flatterte. Jetzt pro Leg auf die bekannte Sprache fixiert, Sprachwechsel braucht zwei Sätze.
- Gleiche Sprache auf beiden Seiten: LLM-Hop fällt weg (~600 ms schneller, keine Erfindungs-Chance).
- Lachen, Füllwörter und Satzzeichen-Müll werden verworfen statt vorgelesen (`isSpeakable`), TTS-Stil auf natürliches Telefonsprechen.
- Echo-Nachlauf 700 -> 200 ms (Echo war nicht die Ursache der Phantom-Antworten, der lange Nachlauf schnitt Sprache ab).
- Latenz wird pro Stufe geloggt: `[LAT caller] stt 420 + itp 610 + tts 480 = 1510 ms`.

### Nach dem Testanruf (alter Pfad, REALTIME war nicht gesetzt)
- Gemessen: `stt ~500 + itp ~700-950 + tts ~500-800` = 1,6-2,5 s, dazu die 500 ms VAD-Stille davor. Der LLM-Hop ist der grösste beeinflussbare Posten -> dafür ist der Realtime-Pfad da.
- Kurze Äusserungen fielen aus: `"Hello" -> ""`. Der strikte Prompt hielt Einzelwörter für Fragmente und gab leeren Text zurück -> am Anfang kam gar nichts. Prompt verlangt jetzt ausdrücklich auch Einzelwörter, Grüsse, Ja/Nein; leerer Text nur noch bei gar keinen Wörtern.
- Echo ist doch real: `[callee] "Ich bin hier."` und `[caller] "You are here."` waren unsere eigene KI-Stimme, zurückgehört und erneut übersetzt. Mikrofon-Stummschaltung allein reicht nicht (das Echo kommt verzögert). Jetzt zusätzlich Echo-Erkennung auf Textebene: was wir in ein Leg sprechen, wird 8 s gemerkt (`ECHO_MEMORY_MS`) und ein passendes Transkript dieses Legs verworfen. Nachlauf wieder 300 ms.
- Gleiche Sprache = kein Übersetzen ist Absicht, kein Bug: wer Deutsch spricht und im Menü Deutsch wählt, hört nur die KI-Stimme nachsprechen. Zum Testen eine andere Sprache wählen.

## Stand (27.10., Teil 4)
- Wunsch: kein Original hörbar, immer dieselbe KI-Stimme, auch bei gleicher Sprache; Anrufer-Sprache automatisch.
- gpt-realtime-translate kann das nicht (bleibt bei gleicher Sprache stumm, keine feste Stimme) -> ersetzt.
- Neue Kette pro Seite: `transcriber.js` (Realtime-Transkription, gpt-4o-transcribe, server VAD 500 ms, μ-law direkt) -> `interpreter.js` (gpt-4o-mini: Sprache erkennen + übersetzen, gleiche Sprache bleibt) -> `tts.js` (gpt-4o-mini-tts, Stimme coral, PCM 24 kHz -> 8 kHz) -> nur die andere Seite hört die KI-Stimme.
- Anrufer-Sprache wird aus seinen Sätzen erkannt (`session.callerLang`), Rückrichtung geht in diese Sprache (Standard bis dahin: CALLER_LANG / en).
- Menü: nur noch Zielsprache (1-9) + Nummer.
- Env optional: REALTIME, REALTIME_MODEL, TRANSCRIBE_MODEL, TRANSLATE_MODEL, TTS_MODEL, TTS_VOICE, TTS_INSTRUCTIONS, VAD_SILENCE_MS, VAD_THRESHOLD, NOISE_GATE_RMS, MAX_BACKLOG_MS, ECHO_TAIL_MS.
- Log: `[caller] (lang) "..." -> (de) "..."`, `[LAT ...]` = Satzende bis KI-Stimme.
- Noch nicht mit echtem Anruf getestet. Falls die Transkription mit Fehler startet: Session-Format in `transcriber.js` prüfen (GA vs. beta-Fallback).

## Ablauf
Twilio `/call/inbound` -> TwiML Connect/Stream (role=caller) + REST-Anruf zum Ziel (role=callee) -> WS `/media-stream` (`src/routes/stream.js` paart beide über pairId) -> Realtime EN->DE bzw. DE->EN -> Audio zur jeweils anderen Seite.
