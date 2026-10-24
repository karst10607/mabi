/**
 * AuraPet - Interactive Pet Animation & Sound Engine
 */

const RIG_SKINS = {
  cat2d: {
    dir: './models/cat2d',
    prefix: 'cat',
    emoji: '🐈',
    defaultName: '條碼',
    species: 'cat',
    extraPoses: ['side', 'belly']
  },
  ami2d: {
    dir: './models/ami2d',
    prefix: 'ami',
    emoji: '🧡',
    defaultName: '阿咪',
    species: 'cat',
    extraPoses: []
  },
  kk2d: {
    dir: './models/kk2d',
    prefix: 'kk',
    emoji: '🐕‍🦺',
    defaultName: 'KK',
    species: 'dog',
    extraPoses: []
  }
};

const SKIN_DEFAULT_NAMES = {
  cat2d: '條碼',
  ami2d: '阿咪',
  kk2d: 'KK',
  kitsune: 'Lumi',
  shiba: 'Koma',
  cat: 'Luna',
  slime: 'Mochi',
  custom_photo: '毛孩'
};

const SKIN_EMOJIS = {
  cat2d: '🐈',
  ami2d: '🧡',
  kk2d: '🐕‍🦺',
  kitsune: '🦊',
  shiba: '🐕',
  cat: '🐱',
  slime: '✨',
  custom_photo: '📸'
};

const KNOWN_SKINS = ['cat2d', 'ami2d', 'kk2d', 'kitsune', 'shiba', 'cat', 'slime', 'custom_photo'];

// A slow four-legged walk. `speed` is how fast the body crosses the stage and
// `rate` is the gait cycle speed; at these values roughly two paws leave the
// ground per second while the body stays level.
const WALK = { speed: 46, rate: 4.2 };

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
    const availSkins = this.getAvailableSkins();
    this.skin = availSkins.includes(savedSkin) ? savedSkin : (availSkins[0] || 'cat2d');
    this.nickname = localStorage.getItem('aurapet_name') || SKIN_DEFAULT_NAMES[this.skin] || 'Lumi';
    this.userTitle = localStorage.getItem('aurapet_user_title') || '主人';
    this.soundEnabled = localStorage.getItem('aurapet_sound') !== 'false';
    this.autoSpeech = localStorage.getItem('aurapet_speech') !== 'false';
    
    this.affection = parseInt(localStorage.getItem('aurapet_affection') || '88', 10);
    this.energy = parseInt(localStorage.getItem('aurapet_energy') || '95', 10);
    this.state = 'idle'; // idle, blink, happy, eating, thinking, sleepy
    const savedPosture = localStorage.getItem('aurapet_posture');
    this.posture = ['sit', 'doze', 'rest', 'sleep'].includes(savedPosture) ? savedPosture : 'sit';
    this.loadedRigPose = null;
    this.lastInteractionAt = Date.now();
    
    this.audioCtx = null;
    this.speechTimer = null;
    this.blinkInterval = null;
    this.sleepParticleInterval = null;
    this.rig2d = null;
    this.rigToken = 0;
    this.roamClassTimer = null;
    this.loco = {
      x: 0,
      z: 0,
      moving: false,
      flipX: 1,
      stepSpeed: WALK.rate,
      waypoints: [],
      sceneIdx: -1,
      lastTime: performance.now(),
      running: false,
      rafId: 0,
    };
    this.locoTick = (now) => {
      if (!this.loco.running) return;
      const dt = Math.min(0.05, (now - (this.loco.lastTime || now)) / 1000);
      this.loco.lastTime = now;
      this.stepLocomotion(dt);
      if (this.isLocomotionSettled()) {
        this.loco.running = false;
        this.loco.rafId = 0;
        return;
      }
      this.loco.rafId = requestAnimationFrame(this.locoTick);
    };
    window.petEngine = this;

    // Skins whose walk artwork failed to load; they walk in their sit pose instead
    this.walkPoseBlocked = new Set();
    // Screen-edge roaming moves the whole window, so it travels without waypoints
    this.roamWalking = false;

    this.init();
  }

  init() {
    this.syncPostureUI();
    this.renderSkin();
    this.updateStatsDisplay();
    this.setupInteractions();
    this.setupRoam();
    this.setupWindowVisibility();
    this.startBlinkingLoop();
    this.startSleepParticleLoop();
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
    if (!this.isRigSkin()) this.disposeRig();

    if (this.petNameBadge) {
      this.petNameBadge.textContent = `${this.nickname} ✦`;
      this.petNameBadge.title = '點擊快速切換下一隻寵物';
    }

    if (this.miniPetIcon) {
      this.miniPetIcon.textContent = SKIN_EMOJIS[this.skin] || '🦊';
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
    } else if (this.isRigSkin()) {
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

    const isRig = this.isRigSkin();
    if (isRig && document.getElementById('rig2d-host')) {
      this.container.classList.add('rig-mode');
      document.body.classList.add('skin-rig');
      this.mountRig(this.skin);
      return;
    }
    this.container.innerHTML = svgHtml;
    this.container.classList.toggle('rig-mode', isRig);
    document.body.classList.toggle('skin-rig', isRig);
    if (isRig) this.mountRig(this.skin);
  }

  isRigSkin(skin = this.skin) {
    return Boolean(RIG_SKINS[skin]);
  }

  getHiddenSkins() {
    try {
      const raw = JSON.parse(localStorage.getItem('aurapet_hidden_skins') || '[]');
      return Array.isArray(raw) ? raw.filter((s) => KNOWN_SKINS.includes(s)) : [];
    } catch {
      return [];
    }
  }

  setHiddenSkins(list) {
    const clean = Array.from(new Set(list)).filter((s) => KNOWN_SKINS.includes(s));
    localStorage.setItem('aurapet_hidden_skins', JSON.stringify(clean));
  }

  getAvailableSkins() {
    const hidden = this.getHiddenSkins();
    const avail = KNOWN_SKINS.filter((s) => !hidden.includes(s));
    return avail.length > 0 ? avail : ['cat2d'];
  }

  removeSkin(skinId) {
    const avail = this.getAvailableSkins();
    if (avail.length <= 1 && avail.includes(skinId)) {
      return false;
    }
    const hidden = this.getHiddenSkins();
    if (!hidden.includes(skinId)) {
      hidden.push(skinId);
      this.setHiddenSkins(hidden);
    }
    if (this.skin === skinId) {
      const nextAvail = this.getAvailableSkins();
      this.setSkin(nextAvail[0], { autoNickname: true });
    }
    return true;
  }

  restoreAllSkins() {
    localStorage.removeItem('aurapet_hidden_skins');
  }

  cycleNextSkin() {
    const avail = this.getAvailableSkins().filter((s) =>
      s !== 'custom_photo' || Boolean(localStorage.getItem('aurapet_custom_photo'))
    );
    if (avail.length <= 1) return this.skin;
    const idx = avail.indexOf(this.skin);
    const next = avail[(idx + 1) % avail.length];
    this.setSkin(next, { autoNickname: true });
    this.playSound('pop');
    // Have the new pet trot in from the distance using perspective scaling!
    this.runPerspectiveSequence('switch-entry');
    this.say(`換我從遠處跑來陪${this.userTitle}囉！我是 ${this.nickname} ✨`, 2800);
    return next;
  }

  isRestPose(posture = this.posture) {
    return posture === 'rest' || posture === 'sleep';
  }

  isSleepyPosture(posture = this.posture) {
    return posture === 'doze' || posture === 'sleep';
  }

  getSupportedPostures(skinId = this.skin) {
    const cfg = RIG_SKINS[skinId];
    const base = ['sit', 'doze', 'rest', 'sleep'];
    if (cfg && Array.isArray(cfg.extraPoses) && cfg.extraPoses.length) {
      return [...base, ...cfg.extraPoses];
    }
    return base;
  }

  isTravelling() {
    return Boolean(this.loco?.moving || this.roamWalking);
  }

  getRigPoseKey(posture = this.posture, skinId = this.skin) {
    const cfg = RIG_SKINS[skinId];
    if (this.isTravelling() && cfg && !this.walkPoseBlocked.has(skinId)) {
      return 'walk';
    }
    if ((posture === 'side' || posture === 'belly') && cfg?.extraPoses?.includes(posture)) {
      return posture;
    }
    if (this.isRestPose(posture) || posture === 'side' || posture === 'belly') {
      return 'rest';
    }
    return 'sit';
  }

  applyPoseBodyClasses(poseKey = this.getRigPoseKey()) {
    document.body.classList.toggle('posture-rest', poseKey === 'rest');
    document.body.classList.toggle('posture-side', poseKey === 'side');
    document.body.classList.toggle('posture-belly', poseKey === 'belly');
    document.body.classList.toggle('posture-walk', poseKey === 'walk');
  }

  syncPostureUI(opts = {}) {
    const poseKey = this.getRigPoseKey();
    const isSleepy = this.isSleepyPosture();
    if (!opts.skipBodyClass) {
      this.applyPoseBodyClasses(poseKey);
    }
    document.body.classList.toggle('posture-sleepy', isSleepy);

    const btnRest = document.getElementById('btn-pet-rest');
    const iconEl = document.getElementById('rest-btn-icon');
    if (btnRest) {
      btnRest.classList.toggle('active-posture', this.posture !== 'sit');
      const labels = {
        sit: '目前：坐姿清醒（點擊切換為打瞌睡）',
        doze: '目前：坐姿打瞌睡 [方案A]（點擊切換為趴下休息）',
        rest: '目前：趴下休息 [方案B]（點擊切換為趴睡）',
        sleep: '目前：趴下熟睡 [方案A+B]（點擊切換下一姿態）',
        side: '目前：側躺玩拳頭（點擊切換為仰天躺翻肚）',
        belly: '目前：仰天躺手手高舉（點擊喚醒回坐姿）',
      };
      btnRest.title = labels[this.posture] || '切換休息姿態';
    }
    if (iconEl) {
      const icons = { sit: '💤', doze: '😪', rest: '🐾', sleep: '🌙', side: '🥊', belly: '🙌' };
      iconEl.textContent = icons[this.posture] || '💤';
    }
  }

  setPosture(newPosture, opts = {}) {
    const supported = this.getSupportedPostures();
    if (!supported.includes(newPosture)) newPosture = 'sit';
    const nextPose = this.getRigPoseKey(newPosture);
    const isSleepy = this.isSleepyPosture(newPosture);
    const needsTextureSwap =
      this.isRigSkin() && (!this.rig2d || this.loadedRigPose !== nextPose || this.loadedRigSkin !== this.skin);

    this.posture = newPosture;
    localStorage.setItem('aurapet_posture', newPosture);
    // Defer resizing the container (`posture-rest`/`side`/`belly` classes) until the new texture finishes loading
    // so the current WebGL canvas is not stretched to the wrong aspect ratio before swap.
    this.syncPostureUI({ skipBodyClass: needsTextureSwap });

    if (this.isRigSkin()) {
      if (!needsTextureSwap) {
        this.rig2d.setSleepy(isSleepy);
        const host = document.getElementById('rig2d-host');
        if (host) this.rig2d.setViewport(host.clientWidth, host.clientHeight);
      } else {
        this.mountRig(this.skin);
      }
    } else {
      this.setState(isSleepy ? 'blink' : 'idle', 0);
    }

    if (!opts.silent) {
      const isDog = this.skin === 'kk2d' || this.skin === 'shiba';
      const lines = {
        sit: `睡飽飽精神百倍！${this.userTitle}我們繼續加油 ✨`,
        doze: '呼嚕… 眼皮有點重，坐著打個小盹 😪💤',
        rest: isDog ? '趴下來乘涼休息一下，還是看著你哦 🐾' : '折手手母雞蹲休息一下～ 🐾',
        sleep: isDog ? '趴著瞇一下最舒服了… 呼嚕呼嚕 🌙💤' : '母雞蹲閉眼熟睡中… 呼嚕呼嚕 🌙💤',
        side: '側躺揉揉小拳頭～ 瞇一下眼又偷看你一眼 🥊✨',
        belly: `手手高舉萬歲～！神聖的小肚肚開放讓${this.userTitle}摸摸 🙌❤️`,
      };
      this.say(lines[newPosture], 3200);
    }
  }

  cyclePosture() {
    this.lastInteractionAt = Date.now();
    const order = this.getSupportedPostures();
    const idx = order.indexOf(this.posture);
    const next = order[(idx + 1) % order.length];
    this.playSound('pop');
    if (next === 'doze' || next === 'sleep') {
      this.spawnParticle('💤');
    } else if (next === 'rest' || next === 'side') {
      this.spawnParticle('🐾');
    } else if (next === 'belly') {
      this.spawnParticle('❤️');
    } else {
      this.spawnParticle('✨');
    }
    this.setPosture(next);
    return next;
  }

  startSleepParticleLoop() {
    clearInterval(this.sleepParticleInterval);
    this.sleepParticleInterval = setInterval(() => {
      if (this.isSleepyPosture()) {
        this.spawnParticle('💤');
      } else {
        // Auto-transition to doze/sleep after long idle
        const idleMs = Date.now() - (this.lastInteractionAt || Date.now());
        if (this.posture === 'sit' && idleMs > 180000) {
          this.setPosture('doze', { silent: true });
        } else if (this.posture === 'rest' && idleMs > 180000) {
          this.setPosture('sleep', { silent: true });
        }
      }
    }, 3800);
  }

  async mountRig(skinId = this.skin) {
    const cfg = RIG_SKINS[skinId];
    if (!cfg) return;
    const token = ++this.rigToken;
    try {
      const { PetRig2D } = await import('./rig2d.js');
      const poseKey = this.getRigPoseKey(this.posture, skinId);
      this.targetRigPose = poseKey;
      const basePrefix = poseKey === 'sit' ? cfg.prefix : `${cfg.prefix}_${poseKey}`;
      const meta = (await import(`${cfg.dir}/${basePrefix}_meta.js`)).default;
      if (token !== this.rigToken) return;
      const host = document.getElementById('rig2d-host');
      if (!host) return;
      let rig = this.rig2d;
      if (!rig || rig.disposed) {
        host.innerHTML = '';
        rig = new PetRig2D(host);
        this.rig2d = rig;
        window.rig2d = rig;
      }
      await rig.preload(
        `${cfg.dir}/${basePrefix}_tex.png`,
        meta,
        `${cfg.dir}/${basePrefix}_tex_closed.png`
      );
      if (token !== this.rigToken) return;
      this.applyPoseBodyClasses(poseKey);
      await rig.load(
        `${cfg.dir}/${basePrefix}_tex.png`,
        meta,
        `${cfg.dir}/${basePrefix}_tex_closed.png`
      );
      rig.setSleepy(this.isSleepyPosture() && poseKey !== 'walk', true);
      rig.setLocomotion(this.isTravelling(), this.loco?.stepSpeed || WALK.rate);
      rig.setViewport(host.clientWidth, host.clientHeight);
      rig.stepAndRender(0);
      this.applyPerspectiveTransform();
      this.loadedRigPose = poseKey;
      this.loadedRigSkin = skinId;

      // Warm the walk pose in the background so starting to walk never stalls on a texture load
      if (poseKey !== 'walk') {
        import(`${cfg.dir}/${cfg.prefix}_walk_meta.js`).then((m) => {
          if (!rig.disposed) {
            const walkPrefix = `${cfg.prefix}_walk`;
            rig.preload(`${cfg.dir}/${walkPrefix}_tex.png`, m.default, `${cfg.dir}/${walkPrefix}_tex_closed.png`).catch(() => {});
          }
        }).catch(() => {});
      }
      this.rigRetries = 0;
    } catch (err) {
      // A skin without baked walk artwork keeps its sit pose instead of failing forever
      if (this.getRigPoseKey(this.posture, skinId) === 'walk') {
        this.walkPoseBlocked.add(skinId);
        this.rigRetries = 0;
        this.mountRig(skinId);
        return;
      }
      this.rigRetries = (this.rigRetries || 0) + 1;
      if (this.rigRetries <= 5) {
        setTimeout(() => this.mountRig(skinId), 150 * this.rigRetries);
      } else {
        console.error('2D pet rig failed to load', err);
      }
    }
  }

  disposeRig() {
    ++this.rigToken;
    this.loadedRigPose = null;
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

    // Quick switch pet on badge click
    if (this.petNameBadge) {
      this.petNameBadge.style.cursor = 'pointer';
      this.petNameBadge.addEventListener('click', () => {
        this.cycleNextSkin();
      });
    }

    // Dock Buttons
    const btnPat = document.getElementById('btn-pet-pat');
    if (btnPat) btnPat.addEventListener('click', () => this.pat());

    const btnFeed = document.getElementById('btn-pet-feed');
    if (btnFeed) btnFeed.addEventListener('click', () => this.feed());

    const btnPlay = document.getElementById('btn-pet-play');
    if (btnPlay) btnPlay.addEventListener('click', () => this.play());

    const btnPerspective = document.getElementById('btn-pet-perspective');
    if (btnPerspective) btnPerspective.addEventListener('click', () => this.cyclePerspectiveScene());

    const btnRest = document.getElementById('btn-pet-rest');
    if (btnRest) btnRest.addEventListener('click', () => this.cyclePosture());
  }

  // ==========================================================
  // Perspective Locomotion Engine (four-legged walk + Z-depth)
  // ==========================================================
  // Only a pet that is actually travelling needs a per-frame clock; once the
  // waypoint queue is empty and the transform is back at the stage plane the
  // loop parks itself until the next sequence asks for it.
  startLocomotionLoop() {
    if (this.loco.running) return;
    this.loco.running = true;
    this.loco.lastTime = performance.now();
    this.loco.rafId = requestAnimationFrame(this.locoTick);
  }

  isLocomotionSettled() {
    const L = this.loco;
    return L.waypoints.length === 0 && !L.moving && Math.abs(L.x) < 0.1 && Math.abs(L.z) < 0.002;
  }

  syncLocomotionPose() {
    if (!this.isRigSkin() || !this.rig2d || this.rig2d.disposed) return;
    this.rig2d.setLocomotion(this.isTravelling(), this.loco.stepSpeed || WALK.rate);
    const desiredPose = this.getRigPoseKey(this.posture, this.skin);
    if (this.loadedRigPose !== desiredPose && this.targetRigPose !== desiredPose) {
      this.targetRigPose = desiredPose;
      this.mountRig(this.skin);
    }
  }

  applyPerspectiveTransform() {
    const wrapper = document.getElementById('pet-avatar-wrapper');
    const graphic = this.container;
    const shadow = wrapper ? wrapper.querySelector('.pet-shadow') : null;
    if (!wrapper || !graphic) return;

    const { x, z, flipX } = this.loco;
    const travelling = this.isTravelling();
    const isNeutral = !travelling && Math.abs(x) < 0.4 && Math.abs(z) < 0.004 && flipX === 1;
    if (isNeutral) {
      wrapper.style.transform = '';
      graphic.style.transform = '';
      if (shadow) {
        shadow.style.transform = '';
        shadow.style.opacity = '';
      }
      return;
    }

    // Perspective projection: scale S(z) = 1 / (1 + 1.85 * z)
    // z > 0: deep background (smaller + higher toward horizon)
    // z = 0: normal stage plane
    // z < 0: close-up foreground (larger + shifted down so the face is centered in the window)
    const scale = Math.max(0.24, Math.min(1.62, 1 / (1 + 1.85 * z)));
    const horizonY = z >= 0 ? (-z * 42) : (-z * 215);

    // The walk cycle keeps every paw on the ground, so the body must not rise
    // and fall with it: only depth shifts the pet vertically here.
    wrapper.style.transformOrigin = '50% 88%';
    wrapper.style.transform = `translate3d(${x.toFixed(1)}px, ${horizonY.toFixed(1)}px, 0) scale(${scale.toFixed(3)}, ${scale.toFixed(3)})`;
    graphic.style.transform = `scaleX(${flipX})`;

    if (shadow) {
      shadow.style.transform = `scale(${scale.toFixed(3)})`;
      shadow.style.opacity = Math.min(1, scale * 1.1).toFixed(2);
    }
  }

  stepLocomotion(dt) {
    const L = this.loco;

    if (L.waypoints.length > 0) {
      const wp = L.waypoints[0];
      if (wp.wait > 0 && Math.hypot(wp.x - L.x, (wp.z - L.z) * 140) < 2) {
        if (L.moving) {
          L.moving = false;
          this.syncLocomotionPose();
        }
        wp.wait -= dt;
        if (wp.wait <= 0) {
          if (typeof wp.onDone === 'function') wp.onDone();
          L.waypoints.shift();
        }
      } else {
        const dx = wp.x - L.x;
        const dz = wp.z - L.z;
        // Convert depth z into equivalent pixel distance for uniform perceived speed
        const dist = Math.hypot(dx, dz * 145);
        const speed = wp.speed || WALK.speed;
        if (!L.moving) {
          L.moving = true;
          L.stepSpeed = wp.stepSpeed || WALK.rate;
          this.syncLocomotionPose();
        }
        if (Math.abs(dx) > 4) {
          // The walk textures face front-left, so flip only when travelling right
          L.flipX = dx > 0 ? -1 : 1;
        } else {
          L.flipX = 1;
        }

        const stepDist = speed * dt;
        if (dist <= stepDist || dist < 1.5) {
          L.x = wp.x;
          L.z = wp.z;
          if (!wp.wait || wp.wait <= 0) {
            if (typeof wp.onDone === 'function') wp.onDone();
            L.waypoints.shift();
            if (L.waypoints.length === 0) {
              L.moving = false;
              L.flipX = 1;
              this.syncLocomotionPose();
            }
          }
        } else {
          const r = stepDist / dist;
          L.x += dx * r;
          L.z += dz * r;
        }
      }
      this.applyPerspectiveTransform();
    } else if (L.moving || Math.abs(L.x) > 0.1 || Math.abs(L.z) > 0.002) {
      if (L.moving) {
        L.moving = false;
        L.flipX = 1;
        this.syncLocomotionPose();
      }
      // Nothing is queued, so park the pet exactly on the stage plane; clearing the
      // leftover offset is what lets the locomotion clock stop.
      L.x = 0;
      L.z = 0;
      this.applyPerspectiveTransform();
    }
  }

  runPerspectiveSequence(mode = 'far-walk-in') {
    const L = this.loco;
    L.waypoints = [];
    this.startLocomotionLoop();
    if (this.posture !== 'sit') {
      this.setPosture('sit', { silent: true });
    }

    if (mode === 'switch-entry') {
      L.x = (Math.random() < 0.5 ? -1 : 1) * 28;
      L.z = 0.92;
      L.moving = true;
      this.syncLocomotionPose();
      L.waypoints.push({ x: 0, z: 0, speed: 54 });
      this.applyPerspectiveTransform();
      return;
    }

    if (mode === 'far-walk-in') {
      // Scene 1: Start tiny in the deep background (z = 1.15) and walk forward to z = 0
      L.x = 24;
      L.z = 1.15;
      L.moving = true;
      this.syncLocomotionPose();
      L.waypoints.push(
        { x: -10, z: 0.45, speed: 50 },
        {
          x: 0,
          z: 0,
          speed: 46,
          onDone: () => this.spawnParticle('✨'),
        }
      );
      this.say(`從遠方慢慢走過來找${this.userTitle}囉～！🐾`, 3200);
    } else if (mode === 'side-stroll') {
      // Scene 2: Stroll right out of the AuraPet window border (x = +168px), look back, and walk home
      L.waypoints.push(
        { x: 168, z: 0.12, speed: 52, wait: 0.7 },
        { x: 108, z: 0.06, speed: 40, wait: 0.5 },
        {
          x: 0,
          z: 0,
          speed: 46,
          onDone: () => this.spawnParticle('🐾'),
        }
      );
      this.say('走到視窗外面散個步，再慢慢走回來陪你！🐾✨', 3400);
    } else if (mode === 'deep-patrol') {
      // Scene 3: Deep background patrol: walk out to z=1.08, look around, then amble back
      L.waypoints.push(
        { x: -26, z: 1.08, speed: 54, wait: 0.9 },
        {
          x: 0,
          z: 0,
          speed: 52,
          onDone: () => this.spawnParticle('❤️'),
        }
      );
      this.say('去遠方深處巡邏一圈，再慢慢走回來找你！🔭🐾', 3500);
    } else if (mode === 'closeup-sniff') {
      // Scene 4: Walk close up to the screen (z = -0.20, 1.58x scale) to sniff the user, then step back
      L.waypoints.push(
        {
          x: 0,
          z: -0.20,
          speed: 38,
          wait: 1.25,
          onDone: () => this.spawnParticle('❤️'),
        },
        { x: 0, z: 0, speed: 42 }
      );
      this.say(`湊近螢幕聞聞${this.userTitle}～ 嗅嗅，是喜歡的味道！👃❤️`, 3400);
    }

    this.applyPerspectiveTransform();
  }

  cyclePerspectiveScene() {
    this.lastInteractionAt = Date.now();
    this.playSound('pop');
    const scenes = ['far-walk-in', 'side-stroll', 'deep-patrol', 'closeup-sniff'];
    const icons = ['🚶', '🚪', '🔭', '👃'];
    const titles = [
      '透視散步 [1/4]：遠方深處慢步進場（點擊切換：視窗外散步）',
      '透視散步 [2/4]：走到視窗外再折返（點擊切換：深處巡邏折返）',
      '透視散步 [3/4]：慢步走向遠方深處再走回來（點擊切換：湊近螢幕特寫）',
      '透視散步 [4/4]：慢慢湊近螢幕聞聞你（點擊切換：遠方慢步進場）',
    ];
    this.loco.sceneIdx = ((this.loco.sceneIdx ?? -1) + 1) % scenes.length;
    const idx = this.loco.sceneIdx;
    const btn = document.getElementById('btn-pet-perspective');
    const iconEl = document.getElementById('perspective-btn-icon');
    if (btn) btn.title = titles[idx];
    if (iconEl) iconEl.textContent = icons[idx];
    this.runPerspectiveSequence(scenes[idx]);
    return scenes[idx];
  }

  setupRoam() {
    if (!window.electronAPI || !window.electronAPI.onRoamState) return;
    window.electronAPI.onRoamState((state) => this.setRoamState(state));
  }

  // Only the main process knows whether the window is actually off screen, so it
  // drives parking the rig loop; an unfocused-but-visible pet must keep moving.
  setupWindowVisibility() {
    if (!window.electronAPI || !window.electronAPI.onWindowVisibility) return;
    window.electronAPI.onWindowVisibility((visible) => {
      if (!this.rig2d || this.rig2d.disposed) return;
      if (visible) this.rig2d.wake();
      else this.rig2d.stop();
    });
  }

  setRoamState(state) {
    const walking = state === 'walk-left' || state === 'walk-right';
    document.body.classList.toggle('roam-walk', walking);

    // The window itself carries the pet across the screen, so the rig only needs
    // to know it is travelling and which way it faces.
    this.roamWalking = walking;
    this.loco.flipX = state === 'walk-right' ? -1 : 1;
    if (this.isRigSkin()) {
      if (this.loadedRigSkin !== this.skin || this.loadedRigPose !== this.getRigPoseKey()) {
        this.mountRig(this.skin);
      } else if (this.rig2d && !this.rig2d.disposed) {
        this.rig2d.setLocomotion(walking, this.loco.stepSpeed || WALK.rate);
        this.applyPerspectiveTransform();
      }
    }
  }

  // Pat the pet
  pat(clickX, clickY) {
    this.lastInteractionAt = Date.now();
    if (this.posture === 'doze') this.setPosture('sit', { silent: true });
    else if (this.posture === 'sleep') this.setPosture('rest', { silent: true });
    this.playSound('pat');
    if (window.electronAPI && window.electronAPI.notifyPetActivity) {
      window.electronAPI.notifyPetActivity();
    }
    this.increaseAffection(2);
    this.spawnParticle('❤️', clickX, clickY);
    this.setState('happy', 1200);
    if (this.rig2d) this.rig2d.react('happy');

    const isDog = this.skin === 'kk2d' || this.skin === 'shiba';
    const patLines = isDog ? [
      '好舒服～ 尾巴搖個不停 🐾',
      `最喜歡${this.userTitle}摸摸我啦！❤️`,
      '親密度上升中～ 舔舔你的手！',
      `今天也很努力呢，${this.userTitle}最棒了！`,
      '汪嗚～ 元氣充滿！'
    ] : [
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
    this.lastInteractionAt = Date.now();
    if (this.posture === 'doze') this.setPosture('sit', { silent: true });
    else if (this.posture === 'sleep') this.setPosture('rest', { silent: true });
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
    this.lastInteractionAt = Date.now();
    if (this.posture !== 'sit') this.setPosture('sit', { silent: true });
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

  setSkin(newSkin, opts = {}) {
    const oldDefault = SKIN_DEFAULT_NAMES[this.skin];
    this.skin = newSkin;
    localStorage.setItem('aurapet_skin', newSkin);
    const defaultNames = Object.values(SKIN_DEFAULT_NAMES);
    if (opts.autoNickname || !this.nickname || defaultNames.includes(this.nickname) || this.nickname === oldDefault) {
      const nextName = SKIN_DEFAULT_NAMES[newSkin];
      if (nextName) this.setNickname(nextName);
    }
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
