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
// Add '!' or '?' here if you want those treated as pause boundaries too.
const PAUSE_PUNCTUATION = [',', '.'];

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

  for (const word of words) {
    current.push(word);
    if (endsWithPausePunctuation(word.text)) {
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
      speechSeconds: Math.round((endMs - startMs) / 1000),
      clipSeconds: clipSecondsRounded[i],
      pauseMark
    };
  });
}

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
    return res.json({ status: data.status });
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
