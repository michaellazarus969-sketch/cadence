  require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';

// Punctuation marks that count as a "real pause" boundary.
// AssemblyAI attaches punctuation directly to the word it follows (e.g. "morning,"),
// so a segment ends the moment a word's text ends with one of these.
const PAUSE_PUNCTUATION = [',', '.', '?', '!', '\u2014', ';'];

// A segment also ends whenever there's real silence between two words — even with
// no punctuation at all. AssemblyAI's own punctuation is a best guess and sometimes
// misses a deliberate pause (common with TTS narration read from short script lines),
// so this catches those directly from the actual word timings. Raise this if it's
// splitting mid-sentence gaps that aren't real pauses; lower it if it's still missing some.
const PAUSE_GAP_MS = 300;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB; AssemblyAI will reject anything it can't take
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.use(express.json());

function ensureApiKey(res) {
  if (!API_KEY) {
    res.status(500).json({
      error: 'The server has no ASSEMBLYAI_API_KEY configured. Add one to your .env file and restart (see README.md).'
    });
    return false;
  }
  return true;
}

function endsWithPausePunctuation(wordText) {
  const trimmed = wordText.trim();
  return PAUSE_PUNCTUATION.some((mark) => trimmed.endsWith(mark));
}

// Turn AssemblyAI's flat words[] array into one entry per pause: the words spoken
// since the last pause, when they started and ended (ms, from the ASR's own word-level
// alignment against the original audio), and two durations (see finalizeSegments below).
function buildSegments(words, audioDurationSeconds) {
  const rawSegments = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);

    const nextWord = words[i + 1];
    const hasPunctuationPause = endsWithPausePunctuation(word.text);
    const hasSilencePause = nextWord && (nextWord.start - word.end) >= PAUSE_GAP_MS;

    if (hasPunctuationPause || hasSilencePause) {
      rawSegments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    rawSegments.push(current); // trailing words with no closing punctuation
  }

  return finalizeSegments(rawSegments, audioDurationSeconds);
}

// Distributes rawValues into whole numbers that add up to exactly round(targetSum),
// instead of each value drifting up or down independently when rounded on its own.
// (Round every value down, then hand the leftover +1s to whichever had the largest
// fractional remainder — the standard "largest remainder" apportionment method.)
function largestRemainderRound(rawValues, targetSum) {
  const floors = rawValues.map(Math.floor);
  const target = Math.round(targetSum);
  const need = target - floors.reduce((a, b) => a + b, 0);
  const order = rawValues
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const result = floors.slice();
  for (let k = 0; k < need && k < order.length; k++) {
    result[order[k].i] += 1;
  }
  return result;
}

function finalizeSegments(rawSegments, audioDurationSeconds) {
  if (rawSegments.length === 0) return [];

  const starts = rawSegments.map((seg) => seg[0].start); // ms
  const lastSeg = rawSegments[rawSegments.length - 1];
  const lastWordEndMs = lastSeg[lastSeg.length - 1].end;
  // Trust AssemblyAI's reported audio length when we have it, but never let it be
  // shorter than the last word we actually heard.
  const totalMs = Math.max(
    typeof audioDurationSeconds === 'number' ? audioDurationSeconds * 1000 : lastWordEndMs,
    lastWordEndMs
  );

  // "clipSeconds": how long this segment owns on the timeline until the NEXT segment
  // begins (or until the audio ends, for the last one). This folds the pause that
  // follows into the segment before it, so clips placed back-to-back with zero gaps
  // always add up to exactly the audio's length — safe for video/voiceover syncing.
  const rawClipSeconds = rawSegments.map((seg, i) => {
    const nextStartMs = i < rawSegments.length - 1 ? starts[i + 1] : totalMs;
    return Math.max(0, (nextStartMs - starts[i]) / 1000);
  });
  const clipTarget = rawClipSeconds.reduce((a, b) => a + b, 0);
  const clipSecondsRounded = largestRemainderRound(rawClipSeconds, clipTarget);

  return rawSegments.map((seg, i) => {
    const startMs = seg[0].start;
    const endMs = seg[seg.length - 1].end;
    const lastWord = seg[seg.length - 1].text.trim();
    const pauseMark = PAUSE_PUNCTUATION.find((mark) => lastWord.endsWith(mark)) || null;

    return {
      text: seg.map((w) => w.text).join(' '),
      startSeconds: startMs / 1000,
      endSeconds: endMs / 1000,
      // Just the words themselves — how long they took to say. Segments in a row
      // will NOT sum to the full audio length, since the pauses between them aren't
      // counted here.
      speechSeconds: Math.round((endMs - startMs) / 1000),
      // Use this one for editing: sums to the exact audio length across all segments.
      clipSeconds: clipSecondsRounded[i],
      pauseMark
    };
  });
}

// Step 1 (of 2): accept the upload, hand it to AssemblyAI, and start a transcription job.
// Returns immediately with a jobId — the client polls /api/status/:jobId for the result,
// rather than this request blocking until transcription finishes.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!ensureApiKey(res)) return;
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file was uploaded.' });
    }

    const uploadRes = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
      method: 'POST',
      headers: { authorization: API_KEY },
      body: req.file.buffer
    });
    if (!uploadRes.ok) {
      throw new Error(`AssemblyAI rejected the upload (${uploadRes.status}): ${await uploadRes.text()}`);
    }
    const { upload_url } = await uploadRes.json();

    const transcriptRes = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
      method: 'POST',
      headers: {
        authorization: API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: upload_url,
        punctuate: true,
        format_text: true
      })
    });
    if (!transcriptRes.ok) {
      throw new Error(`AssemblyAI rejected the transcript request (${transcriptRes.status}): ${await transcriptRes.text()}`);
    }
    const transcript = await transcriptRes.json();
    res.json({ jobId: transcript.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

// Step 2 (of 2): the client calls this every couple of seconds with the jobId until it
// gets back status "completed" (or "error"). AssemblyAI itself tracks job state, so this
// route is just a thin, stateless pass-through — nothing to store on the server between polls.
app.get('/api/status/:jobId', async (req, res) => {
  try {
    if (!ensureApiKey(res)) return;

    const pollRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${req.params.jobId}`, {
      headers: { authorization: API_KEY }
    });
    if (!pollRes.ok) {
      throw new Error(`Status check failed (${pollRes.status}): ${await pollRes.text()}`);
    }
    const data = await pollRes.json();

    if (data.status === 'completed') {
      return res.json({
        status: 'completed',
        fullText: data.text,
        audioDurationSeconds: data.audio_duration,
        segments: buildSegments(data.words || [], data.audio_duration)
      });
    }
    if (data.status === 'error') {
      return res.json({ status: 'error', error: data.error });
    }
    return res.json({ status: data.status }); // 'queued' | 'processing'
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

app.listen(PORT, () => {
  if (!API_KEY) {
    console.warn('⚠️  ASSEMBLYAI_API_KEY is not set — copy .env.example to .env and add your key.');
  }
  console.log(`Cadence running at http://localhost:${PORT}`);
});
