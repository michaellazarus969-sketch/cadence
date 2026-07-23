const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const fileNameEl = document.getElementById('file-name');
const changeFileBtn = document.getElementById('change-file');
const audioPlayer = document.getElementById('audio-player');
const transcribeBtn = document.getElementById('transcribe-btn');
const downloadBtn = document.getElementById('download-btn');
const statusEl = document.getElementById('status');
const resultsNoteEl = document.getElementById('results-note');
const resultsEl = document.getElementById('results');

let selectedFile = null;
let currentSegments = [];
let segmentRows = [];
let currentPlayingIndex = -1;
let objectUrl = null;

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    setFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

changeFileBtn.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

function setFile(file) {
  selectedFile = file;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  fileNameEl.textContent = file.name;
  fileInfo.hidden = false;

  audioPlayer.src = objectUrl;
  audioPlayer.hidden = false;

  transcribeBtn.disabled = false;
  downloadBtn.hidden = true;
  resultsNoteEl.hidden = true;
  resultsEl.innerHTML = '';
  currentSegments = [];
  segmentRows = [];
  currentPlayingIndex = -1;
  setStatus('');
}

transcribeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  transcribeBtn.disabled = true;
  downloadBtn.hidden = true;
  resultsEl.innerHTML = '';
  setStatus('Uploading audio\u2026');

  try {
    const formData = new FormData();
    formData.append('audio', selectedFile);

    const startRes = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const startData = await startRes.json();
    if (!startRes.ok) throw new Error(startData.error || 'Upload failed.');

    setStatus('Transcribing\u2026 (roughly real-time or faster, depending on length)');
    const result = await pollForResult(startData.jobId);

    currentSegments = result.segments;
    renderSegments(currentSegments);

    if (currentSegments.length > 0) {
      setStatus(`Done \u2014 ${currentSegments.length} pause${currentSegments.length === 1 ? '' : 's'} found.`);
      downloadBtn.hidden = false;
    } else {
      setStatus('Done \u2014 no speech was detected in this file.');
    }
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', true);
    renderError(err.message);
  } finally {
    transcribeBtn.disabled = false;
  }
});

async function pollForResult(jobId) {
  const startedAt = Date.now();
  const timeoutMs = 10 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2500);
    const res = await fetch(`/api/status/${jobId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Status check failed.');
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(data.error || 'AssemblyAI could not transcribe this file.');
  }
  throw new Error('This is taking much longer than expected. Check your AssemblyAI dashboard for the job status.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function renderSegments(segments) {
  resultsEl.innerHTML = '';
  segmentRows = [];
  currentPlayingIndex = -1;

  if (segments.length === 0) {
    resultsNoteEl.hidden = true;
    return;
  }

  const maxDuration = Math.max(...segments.map((s) => s.clipSeconds), 1);
  const fillsToAnimate = [];
  resultsNoteEl.hidden = false;

  segments.forEach((seg, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'segment';
    row.setAttribute('aria-label', `Play from ${formatTime(seg.startSeconds)}`);

    const meta = document.createElement('div');
    meta.className = 'segment-meta';

    const index = document.createElement('span');
    index.className = 'segment-index';
    index.textContent = String(i + 1).padStart(2, '0');

    const time = document.createElement('span');
    time.textContent = `${formatTime(seg.startSeconds)} \u2192 ${formatTime(seg.endSeconds)}`;

    const duration = document.createElement('span');
    duration.className = 'segment-duration';
    duration.textContent = `${seg.clipSeconds}s`;

    meta.append(index, time, duration);
    row.appendChild(meta);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    if (seg.pauseMark === ',') fill.classList.add('pause-comma');
    if (seg.pauseMark === '.') fill.classList.add('pause-full-stop');

    const targetPct = Math.max(4, (seg.clipSeconds / maxDuration) * 100);
    fillsToAnimate.push([fill, targetPct]);

    track.appendChild(fill);
    row.appendChild(track);

    const text = document.createElement('div');
    text.className = 'segment-text';
    text.textContent = seg.text;
    row.appendChild(text);

    row.addEventListener('click', () => {
      audioPlayer.currentTime = seg.startSeconds;
      audioPlayer.play();
    });

    resultsEl.appendChild(row);
    segmentRows.push(row);
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fillsToAnimate.forEach(([fill, pct]) => {
        fill.style.width = `${pct}%`;
      });
    });
  });
}

function renderError(message) {
  resultsNoteEl.hidden = true;
  resultsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'error-state';
  el.textContent = message || 'Something went wrong.';
  resultsEl.appendChild(el);
}

audioPlayer.addEventListener('timeupdate', () => {
  if (!currentSegments.length) return;
  const t = audioPlayer.currentTime;
  const idx = currentSegments.findIndex((seg, i) => {
    const nextStart = currentSegments[i + 1] ? currentSegments[i + 1].startSeconds : Infinity;
    return t >= seg.startSeconds && t < nextStart;
  });
  if (idx !== currentPlayingIndex) {
    if (currentPlayingIndex >= 0 && segmentRows[currentPlayingIndex]) {
      segmentRows[currentPlayingIndex].classList.remove('playing');
    }
    if (idx >= 0 && segmentRows[idx]) {
      segmentRows[idx].classList.add('playing');
    }
    currentPlayingIndex = idx;
  }
});

function formatTime(totalSeconds) {
  const rounded = Math.round(totalSeconds * 10) / 10;
  const m = Math.floor(rounded / 60);
  const s = rounded - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

downloadBtn.addEventListener('click', () => {
  if (!currentSegments.length) return;
  const blob = new Blob([JSON.stringify(currentSegments, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : 'cadence';
  a.href = url;
  a.download = `${base}-pauses.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
