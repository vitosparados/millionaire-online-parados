/* =========================================================
   MQAudio — звуковые эффекты и фоновая музыка через Web Audio API.
   Никаких сторонних mp3/аудиофайлов не используется — всё генерируется
   на лету, поэтому здесь нет вопросов авторского права.

   Если у вас есть СВОИ, легально приобретённые аудиофайлы (например,
   собственная лицензионная запись), можно подключить их вместо
   генеративной музыки — положите файлы в /public/audio/menu.mp3 и
   /public/audio/game.mp3, и раскомментируйте блок "ВНЕШНИЕ ФАЙЛЫ" внизу.
========================================================= */
(function () {
  let ctx = null;
  let ambientOn = false;
  let ambientNodes = null;
  let sfxOn = true;
  let ambientKind = 'menu'; // 'menu' | 'game'

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function playBlip() {
    if (!sfxOn) return;
    try {
      const c = getCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(520, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(760, c.currentTime + 0.08);
      g.gain.setValueAtTime(0.07, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.12);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.13);
    } catch (e) { /* аудио недоступно — просто молчим */ }
  }

  function playTick(strong) {
    if (!sfxOn) return;
    try {
      const c = getCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.value = strong ? 880 : 660;
      g.gain.setValueAtTime(strong ? 0.05 : 0.035, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.1);
    } catch (e) { /* аудио недоступно — просто молчим */ }
  }

  function playCorrect() {
    if (!sfxOn) return;
    try {
      const c = getCtx();
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        const t = c.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.09, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(g); g.connect(c.destination);
        o.start(t); o.stop(t + 0.4);
      });
    } catch (e) { /* аудио недоступно — просто молчим */ }
  }

  function playWrong() {
    if (!sfxOn) return;
    try {
      const c = getCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(90, c.currentTime + 0.4);
      g.gain.setValueAtTime(0.08, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.45);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.46);
    } catch (e) { /* аудио недоступно — просто молчим */ }
  }

  function stopAmbient() {
    if (!ambientOn || !ambientNodes) { ambientOn = false; return; }
    ambientOn = false;
    try {
      Object.values(ambientNodes).forEach(n => { if (n && n.stop) n.stop(); });
    } catch (e) { /* уже остановлено */ }
    ambientNodes = null;
  }

  // Тихий генеративный эмбиент-фон — атмосферная подложка без узнаваемой мелодии,
  // чтобы не нарушать чьи-либо авторские права. kind='menu' — спокойнее и ниже,
  // kind='game' — чуть более "напряжённый" пульсирующий вариант для самой игры.
  function startAmbient(kind) {
    stopAmbient();
    ambientKind = kind || 'menu';
    try {
      const c = getCtx();
      const master = c.createGain();
      master.gain.value = ambientKind === 'game' ? 0.045 : 0.035;
      master.connect(c.destination);

      const baseFreq = ambientKind === 'game' ? 98 : 110;
      const osc1 = c.createOscillator(); osc1.type = 'sine'; osc1.frequency.value = baseFreq;
      const osc2 = c.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = baseFreq * 1.5;
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = ambientKind === 'game' ? 0.18 : 0.07;
      const lfoGain = c.createGain(); lfoGain.gain.value = ambientKind === 'game' ? 0.02 : 0.015;
      lfo.connect(lfoGain); lfoGain.connect(master.gain);

      osc1.connect(master); osc2.connect(master);
      osc1.start(); osc2.start(); lfo.start();

      ambientNodes = { osc1, osc2, lfo };
      ambientOn = true;
    } catch (e) { /* аудио недоступно — просто молчим */ }
  }

  function toggleAmbient(kind) {
    if (ambientOn) { stopAmbient(); return false; }
    startAmbient(kind);
    return true;
  }

  function setSfxEnabled(v) { sfxOn = v; }

  // Звук наведения ("бульк") на интерактивных элементах через делегирование событий —
  // работает даже для элементов, которые появляются в DOM позже (динамически).
  let lastHover = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.opt,.btn,.life-btn,.topic-card,.pill-btn,.player-row,.mq-sound-hover');
    if (el && el !== lastHover) { lastHover = el; playBlip(); }
    if (!el) lastHover = null;
  });

  window.MQAudio = {
    playBlip, playTick, playCorrect, playWrong,
    startAmbient, stopAmbient, toggleAmbient, setSfxEnabled, getCtx,
  };

  /* ВНЕШНИЕ ФАЙЛЫ (опционально):
     Если хотите использовать свою собственную лицензионную музыку вместо
     генеративной, замените startAmbient() на воспроизведение файла, например:

     let audioEl = null;
     function startAmbient(kind){
       stopAmbient();
       audioEl = new Audio(kind === 'game' ? '/audio/game.mp3' : '/audio/menu.mp3');
       audioEl.loop = true; audioEl.volume = 0.25;
       audioEl.play().catch(()=>{});
       ambientOn = true;
     }
     function stopAmbient(){ if(audioEl){ audioEl.pause(); audioEl=null; } ambientOn=false; }
  */
})();
