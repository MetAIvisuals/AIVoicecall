import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Serve synthesized audio files so Twilio can fetch them
router.use('/audio', express.static(join(__dirname, '../../audio_cache')));

export default router;
