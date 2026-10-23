/**
 * AuraPet - Interactive Pet Animation & Sound Engine
 */

const KNOWN_SKINS = ['kitsune', 'shiba', 'cat', 'cat2d', 'slime', 'custom_photo'];

class PetEngine {
  constructor() {
    this.container = document.getElementById('pet-graphic');
    this.speechBubble = document.getElementById('speech-bubble');
    this.speechText = document.getElementById('speech-text');
    this.particlesLayer = document.getElementById('particles-layer');
    this.statAffection = document.getElementById('stat-affection');
    this.statEnergy = document.getElementById('stat-energy');
    this.miniPetIcon = document.getElementById('mini-pet-icon');
    this.petNameBadge = document.getElementById('pet-name-badge');

    // Pet State
    // Saved value can outlive a removed skin (e.g. model3d), which would render an empty pet.
    const savedSkin = localStorage.getItem('aurapet_skin');
    this.skin = KNOWN_SKINS.includes(savedSkin) ? savedSkin : 'kitsune';
    this.nickname = localStorage.getItem('aurapet_name') || 'Lumi';
    this.userTitle = localStorage.getItem('aurapet_user_title') || '主人';
    this.soundEnabled = localStorage.getItem('aurapet_sound') !== 'false';
    this.autoSpeech = localStorage.getItem('aurapet_speech') !== 'false';
    
    this.affection = parseInt(localStorage.getItem('aurapet_affection') || '88', 10);
    this.energy = parseInt(localStorage.getItem('aurapet_energy') || '95', 10);
    this.state = 'idle'; // idle, blink, happy, eating, thinking, sleepy
    
    this.audioCtx = null;
    this.speechTimer = null;
    this.blinkInterval = null;
    this.rig2d = null;
    this.rigToken = 0;
    this.roamClassTimer = null;

    this.init();
  }

  init() {
    this.renderSkin();
    this.updateStatsDisplay();
    this.setupInteractions();
    this.setupRoam();
    this.startBlinkingLoop();
    this.startAutoSpeechLoop();

    // Show initial welcome speech
    setTimeout(() => {
      this.say(`${this.userTitle}好呀！我是 ${this.nickname}，今天也陪著你哦～ ✨`, 4500);
    }, 600);
  }

  // Web Audio Synthesizer for zero-dependency cute sounds
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  playSound(type) {
    if (!this.soundEnabled) return;
    try {
      const ctx = this.getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;

      if (type === 'pat' || type === 'purr') {
        // High gentle chime (C6 -> G6)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'feed') {
        // Cute munching / happy blip
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(1046.5, now + 0.18);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'pop') {
        // Bubble pop
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
      } else if (type === 'talk') {
        // Soft chirp
        osc.type = 'sine';
        osc.frequency.setValueAtTime(700, now);
        osc.frequency.exponentialRampToValueAtTime(900, now + 0.06);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      }
    } catch (e) {
      // Audio context might fail if unprompted by gesture
    }
  }

  // SVG Skins Generation
  renderSkin() {
    if (!this.container) return;
    this.disposeRig();

    if (this.petNameBadge) {
      this.petNameBadge.textContent = `${this.nickname} ✦`;
    }

    if (this.miniPetIcon) {
      const emojiMap = { kitsune: '🦊', shiba: '🐕', cat: '🐱', cat2d: '🐈', slime: '✨' };
      this.miniPetIcon.textContent = emojiMap[this.skin] || '🦊';
    }

    let svgHtml = '';

    if (this.skin === 'kitsune') {
      // Lumi - Cyber Kitsune
      svgHtml = `
        <svg class="pet-svg" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="kitBody" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#ff7e5f"/>
              <stop offset="100%" stop-color="#feb47b"/>
            </linearGradient>
            <linearGradient id="kitEar" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#6366f1"/>
              <stop offset="100%" stop-color="#a855f7"/>
            </linearGradient>
            <linearGradient id="kitTail" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#ff7e5f"/>
              <stop offset="70%" stop-color="#feb47b"/>
              <stop offset="100%" stop-color="#ffffff"/>
            </linearGradient>
          </defs>

          <!-- Tail -->
          <g class="pet-tail-group">
            <path d="M78 80 C95 85, 115 75, 110 50 C105 35, 88 45, 82 65" fill="url(#kitTail)" filter="drop-shadow(0 2px 5px rgba(255,126,95,0.4))"/>
          </g>

          <!-- Ears -->
          <g class="pet-ears-group">
            <!-- Left Ear -->
            <polygon points="28,45 15,10 48,28" fill="url(#kitBody)"/>
            <polygon points="28,40 22,18 42,30" fill="url(#kitEar)"/>
            <!-- Right Ear -->
            <polygon points="92,45 105,10 72,28" fill="url(#kitBody)"/>
            <polygon points="92,40 98,18 78,30" fill="url(#kitEar)"/>
          </g>

          <!-- Body -->
          <ellipse cx="60" cy="78" rx="36" ry="32" fill="url(#kitBody)"/>
          <ellipse cx="60" cy="84" rx="22" ry="20" fill="#fff5eb"/>

          <!-- Head -->
          <ellipse cx="60" cy="56" rx="38" ry="32" fill="url(#kitBody)"/>
          <path d="M30 65 Q 60 90 90 65 Q 60 76 30 65 Z" fill="#fff5eb"/>

          <!-- Forehead Cyber Diamond Mark -->
          <polygon points="60,34 64,40 60,46 56,40" fill="#6366f1" filter="drop-shadow(0 0 4px #818cf8)"/>

          <!-- Eyes -->
          <g class="pet-eyes-group" id="pet-eyes">
            <ellipse class="eye eye-left" cx="44" cy="54" rx="4.5" ry="6" fill="#1e1b4b"/>
            <circle cx="42.5" cy="52" r="2" fill="#ffffff"/>
            
            <ellipse class="eye eye-right" cx="76" cy="54" rx="4.5" ry="6" fill="#1e1b4b"/>
            <circle cx="74.5" cy="52" r="2" fill="#ffffff"/>
          </g>

          <!-- Cheeks Blush -->
          <circle cx="34" cy="62" r="6" fill="#f43f5e" opacity="0.35"/>
          <circle cx="86" cy="62" r="6" fill="#f43f5e" opacity="0.35"/>

          <!-- Nose & Mouth -->
          <polygon points="60,63 58,60 62,60" fill="#1e1b4b"/>
          <path id="pet-mouth" d="M56 66 Q 60 70 64 66" stroke="#1e1b4b" stroke-width="2" stroke-linecap="round" fill="none"/>

          <!-- Paws -->
          <ellipse cx="46" cy="100" rx="9" ry="6" fill="#ffffff"/>
          <ellipse cx="74" cy="100" rx="9" ry="6" fill="#ffffff"/>
        </svg>
      `;
    } else if (this.skin === 'shiba') {
      // Koma - Shiba Pup
      svgHtml = `
        <svg class="pet-svg" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="shibaFur" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#d97706"/>
              <stop offset="100%" stop-color="#f59e0b"/>
            </linearGradient>
          </defs>
          <!-- Curly Tail -->
          <path d="M84 76 C105 70, 115 50, 100 45 C90 40, 85 55, 92 68" stroke="url(#shibaFur)" stroke-width="12" stroke-linecap="round" fill="none"/>
          
          <!-- Ears -->
          <polygon points="26,44 20,16 46,26" fill="url(#shibaFur)"/>
          <polygon points="94,44 100,16 74,26" fill="url(#shibaFur)"/>
          
          <!-- Body -->
          <ellipse cx="60" cy="80" rx="36" ry="30" fill="url(#shibaFur)"/>
          
          <!-- Head -->
          <circle cx="60" cy="56" r="34" fill="url(#shibaFur)"/>
          <ellipse cx="40" cy="64" rx="14" ry="12" fill="#fffbeb"/>
          <ellipse cx="80" cy="64" rx="14" ry="12" fill="#fffbeb"/>
          <ellipse cx="60" cy="68" rx="16" ry="12" fill="#fffbeb"/>

          <!-- Eyebrow Dots -->
          <circle cx="44" cy="42" r="3.5" fill="#fffbeb"/>
          <circle cx="76" cy="42" r="3.5" fill="#fffbeb"/>

          <!-- Eyes -->
          <g id="pet-eyes">
            <ellipse class="eye" cx="44" cy="54" rx="4" ry="5.5" fill="#262626"/>
            <circle cx="43" cy="52" r="1.8" fill="#fff"/>
            <ellipse class="eye" cx="76" cy="54" rx="4" ry="5.5" fill="#262626"/>
            <circle cx="75" cy="52" r="1.8" fill="#fff"/>
          </g>

          <!-- Cheeks -->
          <circle cx="34" cy="65" r="5" fill="#f43f5e" opacity="0.3"/>
          <circle cx="86" cy="65" r="5" fill="#f43f5e" opacity="0.3"/>

          <!-- Nose & Mouth & Tongue -->
          <ellipse cx="60" cy="62" rx="4" ry="3" fill="#262626"/>
          <path id="pet-mouth" d="M54 67 Q 60 72 66 67" stroke="#262626" stroke-width="2" stroke-linecap="round" fill="none"/>
          <path d="M57 70 C57 75, 63 75, 63 70" fill="#f43f5e"/>

          <!-- Paws -->
          <ellipse cx="44" cy="100" rx="9" ry="6" fill="#fffbeb"/>
          <ellipse cx="76" cy="100" rx="9" ry="6" fill="#fffbeb"/>
        </svg>
      `;
    } else if (this.skin === 'cat') {
      // Luna - Neon Cat
      svgHtml = `
        <svg class="pet-svg" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="catDark" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#312e81"/>
              <stop offset="100%" stop-color="#4c1d95"/>
            </linearGradient>
          </defs>
          <!-- Tail -->
          <path d="M82 82 C105 85, 115 65, 105 45" stroke="url(#catDark)" stroke-width="8" stroke-linecap="round" fill="none"/>
          
          <!-- Ears -->
          <polygon points="25,40 18,10 48,22" fill="url(#catDark)"/>
          <polygon points="28,35 24,18 42,24" fill="#ec4899"/>
          <polygon points="95,40 102,10 72,22" fill="url(#catDark)"/>
          <polygon points="92,35 96,18 78,24" fill="#ec4899"/>

          <!-- Body & Head -->
          <ellipse cx="60" cy="80" rx="35" ry="28" fill="url(#catDark)"/>
          <circle cx="60" cy="54" r="32" fill="url(#catDark)"/>

          <!-- Eyes (Big Neon Cyan Eyes) -->
          <g id="pet-eyes">
            <ellipse class="eye" cx="44" cy="52" rx="6" ry="7" fill="#06b6d4" filter="drop-shadow(0 0 4px #22d3ee)"/>
            <ellipse cx="44" cy="52" rx="2.5" ry="6" fill="#082f49"/>
            <circle cx="42" cy="49" r="2" fill="#ffffff"/>
            
            <ellipse class="eye" cx="76" cy="52" rx="6" ry="7" fill="#06b6d4" filter="drop-shadow(0 0 4px #22d3ee)"/>
            <ellipse cx="76" cy="52" rx="2.5" ry="6" fill="#082f49"/>
            <circle cx="74" cy="49" r="2" fill="#ffffff"/>
          </g>

          <!-- Whiskers -->
          <line x1="22" y1="58" x2="36" y2="60" stroke="#a5b4fc" stroke-width="1.5"/>
          <line x1="20" y1="65" x2="35" y2="64" stroke="#a5b4fc" stroke-width="1.5"/>
          <line x1="98" y1="58" x2="84" y2="60" stroke="#a5b4fc" stroke-width="1.5"/>
          <line x1="100" y1="65" x2="85" y2="64" stroke="#a5b4fc" stroke-width="1.5"/>

          <!-- Nose & Mouth -->
          <polygon points="60,61 58,59 62,59" fill="#f472b6"/>
          <path id="pet-mouth" d="M55 64 Q 60 67 65 64" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round" fill="none"/>

          <!-- Bell Collar -->
          <circle cx="60" cy="74" r="4.5" fill="#fbbf24" filter="drop-shadow(0 0 3px #fde047)"/>
        </svg>
      `;
    } else if (this.skin === 'slime') {
      // Mochi - Cosmic Slime
      svgHtml = `
        <svg class="pet-svg" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="slimeGrad" cx="40%" cy="35%" r="70%">
              <stop offset="0%" stop-color="#38bdf8"/>
              <stop offset="60%" stop-color="#6366f1"/>
              <stop offset="100%" stop-color="#4338ca"/>
            </radialGradient>
          </defs>
          <!-- Antenna Star -->
          <path d="M60 14 L62 20 L68 22 L62 24 L60 30 L58 24 L52 22 L58 20 Z" fill="#fde047" filter="drop-shadow(0 0 6px #fde047)"/>
          
          <!-- Slime Body -->
          <path d="M25 80 C 15 55, 35 28, 60 28 C 85 28, 105 55, 95 80 C 90 98, 30 98, 25 80 Z" fill="url(#slimeGrad)" filter="drop-shadow(0 4px 12px rgba(99,102,241,0.5))"/>
          
          <!-- Inner Highlights -->
          <ellipse cx="45" cy="45" rx="8" ry="4" fill="#ffffff" opacity="0.4" transform="rotate(-20 45 45)"/>
          
          <!-- Eyes -->
          <g id="pet-eyes">
            <ellipse class="eye" cx="46" cy="62" rx="4.5" ry="6" fill="#0f172a"/>
            <circle cx="44.5" cy="60" r="2" fill="#ffffff"/>
            <ellipse class="eye" cx="74" cy="62" rx="4.5" ry="6" fill="#0f172a"/>
            <circle cx="72.5" cy="60" r="2" fill="#ffffff"/>
          </g>

          <!-- Cheeks -->
          <circle cx="36" cy="68" r="5" fill="#f43f5e" opacity="0.4"/>
          <circle cx="84" cy="68" r="5" fill="#f43f5e" opacity="0.4"/>

          <!-- Mouth -->
          <path id="pet-mouth" d="M56 68 Q 60 74 64 68" stroke="#0f172a" stroke-width="2" stroke-linecap="round" fill="none"/>
        </svg>
      `;
    } else if (this.skin === 'cat2d') {
      svgHtml = `<div class="rig2d-host" id="rig2d-host"></div>`;
    } else if (this.skin === 'custom_photo') {
      // Real Pet Photo Modeling
      const customPhoto = localStorage.getItem('aurapet_custom_photo');
      const frameStyle = localStorage.getItem('aurapet_custom_frame') || 'aura-contour';
      
      let frameClass = 'real-pet-frame-aura';
      if (frameStyle === 'glass-circle') frameClass = 'real-pet-frame-glass';
      else if (frameStyle === 'cutout-soft') frameClass = 'real-pet-frame-soft';

      if (customPhoto) {
        svgHtml = `
          <div class="real-pet-wrapper">
            <div class="${frameClass}" id="real-pet-frame">
              <img src="${customPhoto}" class="real-pet-img" alt="${this.nickname}">
            </div>
          </div>
        `;
      } else {
        // Fallback placeholder if no photo uploaded yet
        svgHtml = `
          <div class="real-pet-wrapper">
            <div class="real-pet-frame-aura">
              <div style="font-size: 52px; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">
                🐾
              </div>
            </div>
          </div>
        `;
      }
    }

    this.container.innerHTML = svgHtml;
    this.container.classList.toggle('rig-mode', this.skin === 'cat2d');
    document.body.classList.toggle('skin-rig', this.skin === 'cat2d');
    if (this.skin === 'cat2d') this.mountRig();
  }

  async mountRig() {
    const token = this.rigToken;
    const host = document.getElementById('rig2d-host');
    if (!host) return;
    try {
      const { PetRig2D } = await import('./rig2d.js');
      const meta = (await import('./models/cat2d/cat_meta.js')).default;
      if (token !== this.rigToken) return;
      const rig = new PetRig2D(host);
      await rig.load('./models/cat2d/cat_tex.png', meta, './models/cat2d/cat_tex_closed.png');
      if (token !== this.rigToken) { rig.dispose(); return; }
      rig.setViewport(host.clientWidth, host.clientHeight);
      this.rig2d = rig;
      window.rig2d = rig;
    } catch (err) {
      console.error('2D pet rig failed to load', err);
    }
  }

  disposeRig() {
    ++this.rigToken;
    if (this.rig2d) {
      this.rig2d.dispose();
      this.rig2d = null;
      window.rig2d = null;
    }
  }

  // Interactivity
  setupInteractions() {
    const avatarWrapper = document.getElementById('pet-avatar-wrapper');
    if (avatarWrapper) {
      avatarWrapper.addEventListener('click', (e) => {
        this.pat(e.clientX, e.clientY);
      });
    }

    // Dock Buttons
    const btnPat = document.getElementById('btn-pet-pat');
    if (btnPat) btnPat.addEventListener('click', () => this.pat());

    const btnFeed = document.getElementById('btn-pet-feed');
    if (btnFeed) btnFeed.addEventListener('click', () => this.feed());

    const btnPlay = document.getElementById('btn-pet-play');
    if (btnPlay) btnPlay.addEventListener('click', () => this.play());
  }

  setupRoam() {
    if (!window.electronAPI || !window.electronAPI.onRoamState) return;
    window.electronAPI.onRoamState((state) => this.setRoamState(state));
  }

  setRoamState(state) {
    clearTimeout(this.roamClassTimer);
    this.roamClassTimer = null;
    document.body.classList.remove('roam-takeoff', 'roam-air', 'roam-land');

    if (state === 'takeoff') {
      document.body.classList.add('roam-takeoff');
      // 'air' normally arrives on its own; this keeps the crouch from sticking
      // if the hop is cancelled mid-launch.
      this.roamClassTimer = setTimeout(() => {
        if (document.body.classList.contains('roam-takeoff')) {
          document.body.classList.remove('roam-takeoff');
          document.body.classList.add('roam-air');
        }
      }, 220);
      return;
    }

    if (state === 'air') {
      document.body.classList.add('roam-air');
      return;
    }

    if (state === 'land') {
      document.body.classList.add('roam-land');
      if (this.rig2d) this.rig2d.react('play');
      this.roamClassTimer = setTimeout(() => {
        document.body.classList.remove('roam-land');
      }, 380);
    }
  }

  // Pat the pet
  pat(clickX, clickY) {
    this.playSound('pat');
    if (window.electronAPI && window.electronAPI.notifyPetActivity) {
      window.electronAPI.notifyPetActivity();
    }
    this.increaseAffection(2);
    this.spawnParticle('❤️', clickX, clickY);
    this.setState('happy', 1200);
    if (this.rig2d) this.rig2d.react('happy');

    const patLines = [
      '好舒服～ 呼嚕呼嚕 (*/ω＼*)',
      `最喜歡${this.userTitle}摸摸我啦！❤️`,
      '親密度上升中～ 蹭蹭你的手！',
      `今天也很努力呢，${this.userTitle}最棒了！`,
      '喵嗚～ 元氣充滿！'
    ];
    this.say(patLines[Math.floor(Math.random() * patLines.length)], 3000);
  }

  // Feed the pet
  feed() {
    this.playSound('feed');
    if (window.electronAPI && window.electronAPI.notifyPetActivity) {
      window.electronAPI.notifyPetActivity();
    }
    this.increaseEnergy(5);
    this.spawnParticle('🍣');
    this.setState('eating', 1500);
    if (this.rig2d) this.rig2d.react('eating');

    const snacks = ['鮮美三文魚壽司', '甜甜小布丁', '香脆小魚乾', '香濃小泡芙'];
    const snack = snacks[Math.floor(Math.random() * snacks.length)];
    this.say(`啊姆啊姆～ 好好吃的${snack}！能量值 +5 ⚡`, 3500);
  }

  // Play with pet
  play() {
    this.playSound('pop');
    if (window.electronAPI && window.electronAPI.notifyPetActivity) {
      window.electronAPI.notifyPetActivity();
    }
    this.increaseAffection(3);
    this.decreaseEnergy(2);
    this.spawnParticle('🎾');
    this.spawnParticle('✨');
    this.setState('happy', 1400);
    if (this.rig2d) this.rig2d.react('play');

    this.say('接住球球了！耶～ 今天也是元氣滿滿的一天！🎾', 3500);
  }

  increaseAffection(pts) {
    this.affection = Math.min(100, this.affection + pts);
    this.updateStatsDisplay();
  }

  increaseEnergy(pts) {
    this.energy = Math.min(100, this.energy + pts);
    this.updateStatsDisplay();
  }

  decreaseEnergy(pts) {
    this.energy = Math.max(10, this.energy - pts);
    this.updateStatsDisplay();
  }

  updateStatsDisplay() {
    if (this.statAffection) this.statAffection.textContent = this.affection;
    if (this.statEnergy) this.statEnergy.textContent = this.energy;

    localStorage.setItem('aurapet_affection', this.affection.toString());
    localStorage.setItem('aurapet_energy', this.energy.toString());
  }

  // Particle Emitter
  spawnParticle(char, clientX, clientY) {
    if (!this.particlesLayer) return;

    const p = document.createElement('div');
    p.className = 'particle';
    p.textContent = char;

    // Position near pet center or click
    const rect = this.particlesLayer.getBoundingClientRect();
    const x = clientX ? (clientX - rect.left) : (rect.width / 2 + (Math.random() * 40 - 20));
    const y = clientY ? (clientY - rect.top) : (rect.height / 2 + (Math.random() * 20 - 10));

    p.style.left = `${x}px`;
    p.style.top = `${y}px`;

    this.particlesLayer.appendChild(p);

    setTimeout(() => {
      p.remove();
    }, 1200);
  }

  // State Management & Eyes
  setState(newState, duration = 1000) {
    this.state = newState;
    const eyes = document.querySelectorAll('#pet-eyes .eye');
    const mouth = document.getElementById('pet-mouth');

    if (newState === 'happy' || newState === 'eating') {
      eyes.forEach(e => {
        e.setAttribute('ry', '1.5'); // squint happy
      });
      if (mouth) mouth.setAttribute('d', 'M54 65 Q 60 74 66 65');
    } else if (newState === 'blink') {
      eyes.forEach(e => {
        e.setAttribute('ry', '0.8');
      });
    } else {
      // Idle
      eyes.forEach(e => {
        e.setAttribute('ry', '6');
      });
      if (mouth) mouth.setAttribute('d', 'M56 66 Q 60 70 64 66');
    }

    if (duration > 0) {
      setTimeout(() => {
        this.setState('idle', 0);
      }, duration);
    }
  }

  // Random realistic blinking loop
  startBlinkingLoop() {
    const doBlink = () => {
      if (this.state === 'idle') {
        this.setState('blink', 150);
      }
      const nextDelay = 2500 + Math.random() * 4500;
      this.blinkInterval = setTimeout(doBlink, nextDelay);
    };
    this.blinkInterval = setTimeout(doBlink, 2000);
  }

  // Speech Bubble System
  say(text, duration = 4000) {
    if (!this.speechBubble || !this.speechText) return;

    clearTimeout(this.speechTimer);
    this.speechText.textContent = text;
    this.speechBubble.classList.remove('hidden');

    this.speechTimer = setTimeout(() => {
      this.speechBubble.classList.add('hidden');
    }, duration);
  }

  // Contextual Greetings & Idle Speech Loop
  startAutoSpeechLoop() {
    setInterval(() => {
      if (!this.autoSpeech) return;
      if (this.speechBubble && !this.speechBubble.classList.contains('hidden')) return;

      const now = new Date();
      const hour = now.getHours();

      const timeQuotes = [];
      if (hour >= 6 && hour < 11) {
        timeQuotes.push('早安！今天也是充滿希望的一天，深呼吸開始吧！☀️');
        timeQuotes.push('早餐吃了嗎？吃飽飽才有好精神哦～ 🥪');
      } else if (hour >= 11 && hour < 14) {
        timeQuotes.push('午餐時間到啦！去吃頓好吃的犒賞自己吧 🍱');
        timeQuotes.push('工作一上午辛苦啦，放鬆一下眼睛與肩頸～');
      } else if (hour >= 14 && hour < 18) {
        timeQuotes.push('下午容易犯困，記得喝杯溫水或伸個懶腰哦 ☕');
        timeQuotes.push('有什麼難題嗎？隨時按 Option+Space 找我幫忙！');
      } else if (hour >= 18 && hour < 22) {
        timeQuotes.push('傍晚好！今天的工作目標完成了多少呢？✨');
        timeQuotes.push('下班後記得留點時間做讓自己開心的事哦！');
      } else {
        timeQuotes.push('夜深了，螢幕光很刺眼，要早點休息呀 🌙');
        timeQuotes.push(`夜貓子${this.userTitle}，別太熬夜，身體最重要哦～ 💤`);
      }

      const idleQuotes = [
        '按 Option+Space 可以隨時召喚我的完整 AI 助手形態哦！💬',
        `${this.userTitle}，我隨時準備好為你解答問題或寫代碼啦 💻`,
        '動一動手腕，喝口水，我一直陪著你呢 🌸',
        '想聊聊天嗎？點擊我的肚子也可以展開對話視窗哦！'
      ];

      const pool = [...timeQuotes, ...idleQuotes];
      const quote = pool[Math.floor(Math.random() * pool.length)];
      this.say(quote, 4500);
    }, 45000); // Trigger every 45s
  }

  setSkin(newSkin) {
    this.skin = newSkin;
    localStorage.setItem('aurapet_skin', newSkin);
    this.renderSkin();
  }

  setNickname(newName) {
    this.nickname = newName || 'Lumi';
    localStorage.setItem('aurapet_name', this.nickname);
    if (this.petNameBadge) this.petNameBadge.textContent = `${this.nickname} ✦`;
  }

  setUserTitle(title) {
    this.userTitle = title || '主人';
    localStorage.setItem('aurapet_user_title', this.userTitle);
  }
}

window.PetEngine = PetEngine;
