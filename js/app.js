/* ==========================================================================
   Audio Booster — lógica de áudio (Web Audio API)

   Cadeia de sinal:
   fonte (arquivo ou microfone)
     -> gainNode      (reforço de volume, 0%–400%)
     -> bassFilter    (lowshelf, 200 Hz)
     -> midFilter     (peaking, 1000 Hz)
     -> trebleFilter  (highshelf, 3000 Hz)
     -> compressor    (limitador anti-clipping, ligável)
     -> destino (alto-falantes) + analisadores (forma de onda / VU meters)

   A exportação renderiza a mesma cadeia off-line (OfflineAudioContext)
   sobre o AudioBuffer decodificado do arquivo, e o resultado é codificado
   como um WAV PCM 16-bit para download.
   ========================================================================== */

(() => {
  'use strict';

  // ---------- Elementos da UI ----------
  const el = {
    tabFile: document.getElementById('tabFile'),
    tabMic: document.getElementById('tabMic'),
    fileDeck: document.getElementById('fileDeck'),
    micDeck: document.getElementById('micDeck'),

    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    fileName: document.getElementById('fileName'),
    audioEl: document.getElementById('audioEl'),

    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    stopBtn: document.getElementById('stopBtn'),
    seek: document.getElementById('seek'),
    timeCurrent: document.getElementById('timeCurrent'),
    timeDuration: document.getElementById('timeDuration'),

    micBtn: document.getElementById('micBtn'),
    micBtnLabel: document.getElementById('micBtnLabel'),

    waveform: document.getElementById('waveform'),
    meterFillL: document.getElementById('meterFillL'),
    meterFillR: document.getElementById('meterFillR'),
    meterPeakL: document.getElementById('meterPeakL'),
    meterPeakR: document.getElementById('meterPeakR'),
    clipLed: document.getElementById('clipLed'),

    gainFader: document.getElementById('gainFader'),
    gainReadout: document.getElementById('gainReadout'),
    bassFader: document.getElementById('bassFader'),
    bassReadout: document.getElementById('bassReadout'),
    midFader: document.getElementById('midFader'),
    midReadout: document.getElementById('midReadout'),
    trebleFader: document.getElementById('trebleFader'),
    trebleReadout: document.getElementById('trebleReadout'),
    limiterToggle: document.getElementById('limiterToggle'),

    resetBtn: document.getElementById('resetBtn'),
    exportBtn: document.getElementById('exportBtn'),
    exportNote: document.getElementById('exportNote'),

    brandLed: document.getElementById('brandLed'),
    status: document.getElementById('status'),
    statusText: document.getElementById('statusText'),
  };

  // ---------- Estado de áudio ----------
  let audioCtx = null;
  let gainNode, bassFilter, midFilter, trebleFilter, compressor;
  let waveformAnalyser, splitter, meterAnalyserL, meterAnalyserR;
  let currentSourceNode = null;
  let mediaElSource = null;
  let micStream = null;

  let decodedBuffer = null;   // AudioBuffer do arquivo, usado na exportação
  let activeSource = 'file';  // 'file' | 'mic'

  let peakL = 0, peakR = 0;
  let clipHoldUntil = 0;

  const LIMITER_ON = { threshold: -3, knee: 6, ratio: 12, attack: 0.003, release: 0.25 };
  const LIMITER_OFF = { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 };

  // ---------- Setup do grafo de áudio (uma vez, no primeiro gesto do usuário) ----------
  function ensureAudioGraph() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    gainNode = audioCtx.createGain();
    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 200;

    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = 'peaking';
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 0.8;

    trebleFilter = audioCtx.createBiquadFilter();
    trebleFilter.type = 'highshelf';
    trebleFilter.frequency.value = 3000;

    compressor = audioCtx.createDynamicsCompressor();
    applyLimiterState(el.limiterToggle.checked);

    waveformAnalyser = audioCtx.createAnalyser();
    waveformAnalyser.fftSize = 2048;

    splitter = audioCtx.createChannelSplitter(2);
    meterAnalyserL = audioCtx.createAnalyser();
    meterAnalyserR = audioCtx.createAnalyser();
    meterAnalyserL.fftSize = 512;
    meterAnalyserR.fftSize = 512;

    gainNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(trebleFilter);
    trebleFilter.connect(compressor);

    compressor.connect(audioCtx.destination);
    compressor.connect(waveformAnalyser);
    compressor.connect(splitter);
    splitter.connect(meterAnalyserL, 0);
    splitter.connect(meterAnalyserR, 1);

    applyFaderValues();
    startVisualLoop();
  }

  function applyLimiterState(isOn) {
    const cfg = isOn ? LIMITER_ON : LIMITER_OFF;
    const now = compressor.context.currentTime;
    compressor.threshold.setTargetAtTime(cfg.threshold, now, 0.01);
    compressor.knee.setTargetAtTime(cfg.knee, now, 0.01);
    compressor.ratio.setTargetAtTime(cfg.ratio, now, 0.01);
    compressor.attack.setTargetAtTime(cfg.attack, now, 0.01);
    compressor.release.setTargetAtTime(cfg.release, now, 0.01);
  }

  function connectSource(node) {
    if (currentSourceNode) {
      try { currentSourceNode.disconnect(); } catch (_) { /* já desconectado */ }
    }
    currentSourceNode = node;
    node.connect(gainNode);
  }

  // ---------- Faders ----------
  function dbFromBoostPercent(pct) {
    if (pct <= 0) return -Infinity;
    return 20 * Math.log10(pct / 100);
  }

  function applyFaderValues() {
    const boostPct = Number(el.gainFader.value);
    const bassDb = Number(el.bassFader.value);
    const midDb = Number(el.midFader.value);
    const trebleDb = Number(el.trebleFader.value);

    if (audioCtx) {
      const now = audioCtx.currentTime;
      gainNode.gain.setTargetAtTime(boostPct / 100, now, 0.01);
      bassFilter.gain.setTargetAtTime(bassDb, now, 0.01);
      midFilter.gain.setTargetAtTime(midDb, now, 0.01);
      trebleFilter.gain.setTargetAtTime(trebleDb, now, 0.01);
    }

    const dbVal = dbFromBoostPercent(boostPct);
    el.gainReadout.textContent = `${boostPct}% · ${dbVal === -Infinity ? '-∞' : dbVal.toFixed(1)} dB`;
    el.bassReadout.textContent = `${bassDb.toFixed(1)} dB`;
    el.midReadout.textContent = `${midDb.toFixed(1)} dB`;
    el.trebleReadout.textContent = `${trebleDb.toFixed(1)} dB`;

    updateFaderFill(el.gainFader);
    updateFaderFill(el.bassFader);
    updateFaderFill(el.midFader);
    updateFaderFill(el.trebleFader);
  }

  function updateFaderFill(input) {
    const min = Number(input.min), max = Number(input.max), val = Number(input.value);
    const pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  }

  [el.gainFader, el.bassFader, el.midFader, el.trebleFader].forEach(input => {
    input.addEventListener('input', applyFaderValues);
  });

  el.limiterToggle.addEventListener('change', () => {
    if (audioCtx) applyLimiterState(el.limiterToggle.checked);
  });

  el.resetBtn.addEventListener('click', () => {
    el.gainFader.value = 100;
    el.bassFader.value = 0;
    el.midFader.value = 0;
    el.trebleFader.value = 0;
    el.limiterToggle.checked = true;
    applyFaderValues();
    if (audioCtx) applyLimiterState(true);
  });

  // ---------- Tabs (fonte) ----------
  function setActiveSource(source) {
    activeSource = source;
    const isFile = source === 'file';
    el.tabFile.classList.toggle('tab--active', isFile);
    el.tabMic.classList.toggle('tab--active', !isFile);
    el.tabFile.setAttribute('aria-selected', String(isFile));
    el.tabMic.setAttribute('aria-selected', String(!isFile));
    el.fileDeck.hidden = !isFile;
    el.micDeck.hidden = isFile;
    el.exportBtn.disabled = !(isFile && decodedBuffer);
    el.exportNote.textContent = isFile ? '' : 'A exportação está disponível apenas para arquivos de áudio.';
  }

  el.tabFile.addEventListener('click', () => setActiveSource('file'));
  el.tabMic.addEventListener('click', () => setActiveSource('mic'));

  // ---------- Fonte: arquivo ----------
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });

  ['dragenter', 'dragover'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.add('is-dragover'); })
  );
  ['dragleave', 'drop'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove('is-dragover'); })
  );
  el.dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    if (file) loadFile(file);
  });

  async function loadFile(file) {
    ensureAudioGraph();
    setStatus(true, `carregando: ${file.name}`);
    el.fileName.textContent = file.name;

    const url = URL.createObjectURL(file);
    el.audioEl.src = url;

    if (!mediaElSource) {
      mediaElSource = audioCtx.createMediaElementSource(el.audioEl);
    }
    connectSource(mediaElSource);

    el.playBtn.disabled = false;
    el.stopBtn.disabled = false;
    el.seek.disabled = false;
    el.exportBtn.disabled = true;
    decodedBuffer = null;

    try {
      const arrayBuffer = await file.arrayBuffer();
      decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      el.exportBtn.disabled = !(activeSource === 'file');
      el.exportNote.textContent = '';
      setStatus(true, `pronto: ${file.name}`);
    } catch (err) {
      el.exportNote.textContent = 'Não foi possível preparar este arquivo para exportação, mas a reprodução deve funcionar.';
      setStatus(true, `pronto (sem exportação): ${file.name}`);
    }
  }

  function setStatus(live, text) {
    el.status.classList.toggle('is-live', live);
    el.statusText.textContent = text;
    el.brandLed.classList.toggle('is-active', live);
  }

  // ---------- Transporte ----------
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  el.playBtn.addEventListener('click', async () => {
    ensureAudioGraph();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (el.audioEl.paused) {
      el.audioEl.play();
    } else {
      el.audioEl.pause();
    }
  });

  el.audioEl.addEventListener('play', () => {
    el.playIcon.innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
    el.playBtn.setAttribute('aria-label', 'Pausar');
    setStatus(true, `reproduzindo: ${el.fileName.textContent}`);
  });
  el.audioEl.addEventListener('pause', () => {
    el.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    el.playBtn.setAttribute('aria-label', 'Reproduzir');
  });
  el.audioEl.addEventListener('ended', () => {
    setStatus(true, `pronto: ${el.fileName.textContent}`);
  });

  el.stopBtn.addEventListener('click', () => {
    el.audioEl.pause();
    el.audioEl.currentTime = 0;
  });

  el.audioEl.addEventListener('loadedmetadata', () => {
    el.seek.max = el.audioEl.duration || 0;
    el.timeDuration.textContent = formatTime(el.audioEl.duration);
  });
  el.audioEl.addEventListener('timeupdate', () => {
    if (!el.seek.matches(':active')) el.seek.value = el.audioEl.currentTime;
    el.timeCurrent.textContent = formatTime(el.audioEl.currentTime);
  });
  el.seek.addEventListener('input', () => {
    el.audioEl.currentTime = Number(el.seek.value);
  });

  // ---------- Fonte: microfone ----------
  el.micBtn.addEventListener('click', async () => {
    ensureAudioGraph();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
      el.micBtn.classList.remove('is-recording');
      el.micBtnLabel.textContent = 'Ativar microfone';
      setStatus(false, 'sem sinal');
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const micSource = audioCtx.createMediaStreamSource(micStream);
      connectSource(micSource);
      el.micBtn.classList.add('is-recording');
      el.micBtnLabel.textContent = 'Desativar microfone';
      setStatus(true, 'microfone ativo');
    } catch (err) {
      setStatus(false, 'permissão negada para o microfone');
    }
  });

  // ---------- Visualização: forma de onda + VU meters ----------
  function startVisualLoop() {
    const canvas = el.waveform;
    const ctx2d = canvas.getContext('2d');

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, rect.height * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const waveData = new Uint8Array(waveformAnalyser.fftSize);
    const meterDataL = new Float32Array(meterAnalyserL.fftSize);
    const meterDataR = new Float32Array(meterAnalyserR.fftSize);

    function rms(arr) {
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
      return Math.sqrt(sum / arr.length);
    }

    function drawWaveform() {
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      waveformAnalyser.getByteTimeDomainData(waveData);

      ctx2d.clearRect(0, 0, w, h);
      ctx2d.beginPath();
      ctx2d.strokeStyle = '#e8a33d';
      ctx2d.lineWidth = 1.5;

      const step = w / waveData.length;
      let x = 0;
      for (let i = 0; i < waveData.length; i++) {
        const v = waveData[i] / 128 - 1;
        const y = h / 2 + v * (h / 2 - 4);
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
        x += step;
      }
      ctx2d.stroke();

      ctx2d.strokeStyle = 'rgba(242,237,228,0.08)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(0, h / 2);
      ctx2d.lineTo(w, h / 2);
      ctx2d.stroke();
    }

    function updateMeters() {
      meterAnalyserL.getFloatTimeDomainData(meterDataL);
      meterAnalyserR.getFloatTimeDomainData(meterDataR);

      const levelL = Math.min(1, rms(meterDataL) * 2.6);
      const levelR = Math.min(1, rms(meterDataR) * 2.6);

      peakL = Math.max(levelL, peakL - 0.012);
      peakR = Math.max(levelR, peakR - 0.012);

      el.meterFillL.style.height = `${levelL * 100}%`;
      el.meterFillR.style.height = `${levelR * 100}%`;
      el.meterPeakL.style.bottom = `${peakL * 100}%`;
      el.meterPeakR.style.bottom = `${peakR * 100}%`;

      let peakSample = 0;
      for (let i = 0; i < meterDataL.length; i++) peakSample = Math.max(peakSample, Math.abs(meterDataL[i]));
      for (let i = 0; i < meterDataR.length; i++) peakSample = Math.max(peakSample, Math.abs(meterDataR[i]));

      if (peakSample > 0.985) clipHoldUntil = performance.now() + 700;
      el.clipLed.classList.toggle('is-clipping', performance.now() < clipHoldUntil);
    }

    function loop() {
      drawWaveform();
      updateMeters();
      requestAnimationFrame(loop);
    }
    loop();
  }

  // ---------- Exportação (renderização off-line + WAV) ----------
  el.exportBtn.addEventListener('click', async () => {
    if (!decodedBuffer) return;
    el.exportBtn.disabled = true;
    el.exportNote.textContent = 'Renderizando áudio reforçado…';

    try {
      const rendered = await renderOffline(decodedBuffer);
      const wavBlob = audioBufferToWav(rendered);
      downloadBlob(wavBlob, buildExportFileName());
      el.exportNote.textContent = 'Exportação concluída — verifique seus downloads.';
    } catch (err) {
      el.exportNote.textContent = 'Falha ao exportar o áudio. Tente novamente.';
    } finally {
      el.exportBtn.disabled = false;
    }
  });

  function buildExportFileName() {
    const base = (el.fileName.textContent || 'audio').replace(/\.[^/.]+$/, '');
    return `${base}-reforcado.wav`;
  }

  async function renderOffline(buffer) {
    const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

    const src = offlineCtx.createBufferSource();
    src.buffer = buffer;

    const gain = offlineCtx.createGain();
    gain.gain.value = Number(el.gainFader.value) / 100;

    const bass = offlineCtx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    bass.gain.value = Number(el.bassFader.value);

    const mid = offlineCtx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    mid.gain.value = Number(el.midFader.value);

    const treble = offlineCtx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 3000;
    treble.gain.value = Number(el.trebleFader.value);

    const comp = offlineCtx.createDynamicsCompressor();
    const cfg = el.limiterToggle.checked ? LIMITER_ON : LIMITER_OFF;
    comp.threshold.value = cfg.threshold;
    comp.knee.value = cfg.knee;
    comp.ratio.value = cfg.ratio;
    comp.attack.value = cfg.attack;
    comp.release.value = cfg.release;

    src.connect(gain).connect(bass).connect(mid).connect(treble).connect(comp).connect(offlineCtx.destination);
    src.start(0);

    return offlineCtx.startRendering();
  }

  // Converte um AudioBuffer em um Blob WAV (PCM 16-bit, header canônico).
  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const numFrames = buffer.length;
    const dataSize = numFrames * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Inicialização ----------
  updateFaderFill(el.gainFader);
  updateFaderFill(el.bassFader);
  updateFaderFill(el.midFader);
  updateFaderFill(el.trebleFader);
  setActiveSource('file');
})();
