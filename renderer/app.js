/**
 * AuraPet - Main Application & UI Orchestrator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Instances
  const pet = new PetEngine();
  const ai = new AIService();

  // Mode & State
  let currentMode = 'pet'; // 'pet' | 'chat'
  let isGenerating = false;
  let chatHistory = [];

  // DOM Elements
  const petContainer = document.getElementById('pet-container');
  const chatContainer = document.getElementById('chat-container');
  const settingsModal = document.getElementById('settings-modal');

  // Mode Buttons
  const btnExpandChat = document.getElementById('btn-expand-chat');
  const btnPetChat = document.getElementById('btn-pet-chat');
  const btnCollapseToPet = document.getElementById('btn-collapse-to-pet');
  const miniPetBadge = document.getElementById('mini-pet-badge');

  // Chat Elements
  const chatMessages = document.getElementById('chat-messages');
  const chatTextarea = document.getElementById('chat-textarea');
  const btnSendMessage = document.getElementById('btn-send-message');
  const btnClearChat = document.getElementById('btn-clear-chat');
  const promptsBar = document.getElementById('prompts-bar');
  const currentModelBadge = document.getElementById('current-model-badge');
  const currentEndpointDisplay = document.getElementById('current-endpoint-display');
  const chatPetStatusText = document.getElementById('chat-pet-status-text');

  // Header / Window Control Buttons
  const btnPinWindow = document.getElementById('btn-pin-window');
  const btnMinimizePet = document.getElementById('btn-minimize-pet');
  const btnCloseApp = document.getElementById('btn-close-app');
  const btnQuickSettings = document.getElementById('btn-quick-settings');
  const btnChatSettings = document.getElementById('btn-chat-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnResetSettings = document.getElementById('btn-reset-settings');

  // Settings Elements
  const selectAiProvider = document.getElementById('select-ai-provider');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKeyVisibility = document.getElementById('btn-toggle-key-visibility');
  const inputBaseUrl = document.getElementById('input-base-url');
  const inputModelName = document.getElementById('input-model-name');
  const inputSystemPrompt = document.getElementById('input-system-prompt');
  const inputPetNickname = document.getElementById('input-pet-nickname');
  const inputUserTitle = document.getElementById('input-user-title');
  const sliderPetScale = document.getElementById('slider-pet-scale');
  const sliderOpacity = document.getElementById('slider-opacity');
  const valOpacity = document.getElementById('val-opacity');
  const checkPetSound = document.getElementById('check-pet-sound');
  const checkAutoSpeech = document.getElementById('check-auto-speech');
  const checkAlwaysTop = document.getElementById('check-always-top');
  const checkRoam = document.getElementById('check-roam');

  // ----------------------------------------------------------------
  // 1. Mode Switching Logic
  // ----------------------------------------------------------------
  function setMode(mode) {
    currentMode = mode;
    if (mode === 'chat') {
      petContainer.classList.add('hidden');
      chatContainer.classList.remove('hidden');
      // Tell Electron main process to resize window
      if (window.electronAPI && window.electronAPI.switchMode) {
        window.electronAPI.switchMode('chat');
      }
      setTimeout(() => chatTextarea.focus(), 150);
    } else {
      chatContainer.classList.add('hidden');
      petContainer.classList.remove('hidden');
      if (window.electronAPI && window.electronAPI.switchMode) {
        window.electronAPI.switchMode('pet');
      }
    }
  }

  btnExpandChat.addEventListener('click', () => setMode('chat'));
  btnPetChat.addEventListener('click', () => setMode('chat'));
  btnCollapseToPet.addEventListener('click', () => setMode('pet'));
  miniPetBadge.addEventListener('click', () => setMode('pet'));

  // Listen for Electron Global Shortcut or Tray trigger
  if (window.electronAPI && window.electronAPI.onToggleModeRequest) {
    window.electronAPI.onToggleModeRequest((targetMode) => {
      setMode(targetMode);
    });
  }

  if (window.electronAPI && window.electronAPI.onPetInteraction) {
    window.electronAPI.onPetInteraction((type) => {
      if (type === 'pat') pet.pat();
      else if (type === 'feed') pet.feed();
    });
  }

  // Minimize & Close
  if (btnMinimizePet) {
    btnMinimizePet.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.minimizeApp) {
        window.electronAPI.minimizeApp();
      }
    });
  }

  if (btnCloseApp) {
    btnCloseApp.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.closeApp) {
        window.electronAPI.closeApp();
      }
    });
  }

  // Pin Toggle
  let isPinned = true;
  if (btnPinWindow) {
    btnPinWindow.addEventListener('click', () => {
      isPinned = !isPinned;
      btnPinWindow.classList.toggle('active', isPinned);
      if (window.electronAPI && window.electronAPI.setAlwaysOnTop) {
        window.electronAPI.setAlwaysOnTop(isPinned);
      }
    });
  }

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Esc closes settings or collapses to pet mode
    if (e.key === 'Escape') {
      if (!settingsModal.classList.contains('hidden')) {
        closeSettings();
      } else if (currentMode === 'chat') {
        setMode('pet');
      }
    }

    // Option + Space toggle
    if (e.altKey && e.code === 'Space') {
      e.preventDefault();
      setMode(currentMode === 'pet' ? 'chat' : 'pet');
    }
  });

  // ----------------------------------------------------------------
  // 2. Chat UI & Streaming Messaging
  // ----------------------------------------------------------------
  function updateModelBadgeDisplay() {
    const provider = ai.provider;
    const model = ai.modelName;

    let badgeText = '✦ 內建智慧模式';
    let hintText = '內建離線智慧模式 (無須 API Key)';

    if (provider === 'openai') {
      badgeText = `⚡ ${model || 'GPT-4o mini'}`;
      hintText = 'OpenAI API 連線中';
    } else if (provider === 'gemini') {
      badgeText = `🌟 ${model || 'Gemini 1.5'}`;
      hintText = 'Google Gemini API 連線中';
    } else if (provider === 'claude') {
      badgeText = `🔮 ${model || 'Claude 3.5'}`;
      hintText = 'Anthropic Claude API 連線中';
    } else if (provider === 'ollama') {
      badgeText = `🦙 ${model || 'Ollama Local'}`;
      hintText = '本機 Ollama 離線模型連線中';
    } else if (provider === 'custom') {
      badgeText = `🌐 ${model || 'Custom API'}`;
      hintText = '自定義 OpenAI-相容端點';
    }

    if (currentModelBadge) currentModelBadge.textContent = badgeText;
    if (currentEndpointDisplay) currentEndpointDisplay.textContent = hintText;
  }
  updateModelBadgeDisplay();

  // Auto-resize chat textarea
  chatTextarea.addEventListener('input', () => {
    chatTextarea.style.height = 'auto';
    chatTextarea.style.height = Math.min(100, Math.max(22, chatTextarea.scrollHeight)) + 'px';
  });

  chatTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnSendMessage.addEventListener('click', () => {
    if (isGenerating) {
      ai.abortCurrent();
      stopGeneratingState();
    } else {
      sendMessage();
    }
  });

  // Quick Prompt Pills
  if (promptsBar) {
    promptsBar.addEventListener('click', (e) => {
      const pill = e.target.closest('.prompt-pill');
      if (!pill) return;
      const promptText = pill.dataset.prompt;
      chatTextarea.value = promptText;
      chatTextarea.focus();
      chatTextarea.dispatchEvent(new Event('input'));
    });
  }

  // Clear Chat History
  btnClearChat.addEventListener('click', () => {
    chatHistory = [];
    chatMessages.innerHTML = `
      <div class="message assistant">
        <div class="message-avatar">${pet.skin === 'shiba' ? '🐕' : pet.skin === 'cat' ? '🐱' : pet.skin === 'slime' ? '✨' : '🦊'}</div>
        <div class="message-body">
          <div class="message-content">
            <p>對話已清空！我是你的 AI 桌面小夥伴 <strong>${pet.nickname}</strong> 🐾</p>
            <p>有什麼問題或靈感，請隨時跟我聊聊吧！</p>
          </div>
          <div class="message-meta">剛剛</div>
        </div>
      </div>
    `;
  });

  // Send Message Routine
  async function sendMessage() {
    const text = chatTextarea.value.trim();
    if (!text || isGenerating) return;

    chatTextarea.value = '';
    chatTextarea.style.height = 'auto';

    // 1. Append User Message
    appendMessage('user', text);
    chatHistory.push({ role: 'user', content: text });

    // 2. Prepare Assistant Message Placeholder
    const assistantMsgEl = createAssistantMessageElement();
    chatMessages.appendChild(assistantMsgEl);
    scrollToBottom();

    // 3. UI State -> Generating
    startGeneratingState();
    pet.playSound('talk');

    const contentDiv = assistantMsgEl.querySelector('.message-content');
    const indicator = document.querySelector('.mini-pet-indicator');
    if (indicator) {
      indicator.className = 'mini-pet-indicator status-thinking';
    }
    if (chatPetStatusText) chatPetStatusText.textContent = `${pet.nickname} is thinking...`;

    // 4. Stream response
    await ai.streamChat(
      chatHistory,
      (partialText) => {
        // Chunk update
        contentDiv.innerHTML = formatMarkdown(partialText) + '<span class="typing-cursor"></span>';
        scrollToBottom();
      },
      () => {
        // Done
        const fullText = contentDiv.innerText.replace(/\u2588/g, '').trim();
        contentDiv.innerHTML = formatMarkdown(contentDiv.innerHTML.replace('<span class="typing-cursor"></span>', ''));
        chatHistory.push({ role: 'assistant', content: fullText });
        stopGeneratingState();
        pet.increaseAffection(1);
      },
      (errMsg) => {
        // Error
        contentDiv.innerHTML = `<span style="color: #ef4444;">⚠️ ${errMsg}</span>`;
        stopGeneratingState();
      }
    );
  }

  function startGeneratingState() {
    isGenerating = true;
    btnSendMessage.classList.add('stop');
    btnSendMessage.title = '停止生成';
    btnSendMessage.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <rect x="5" y="5" width="14" height="14" rx="2"></rect>
      </svg>
    `;
  }

  function stopGeneratingState() {
    isGenerating = false;
    btnSendMessage.classList.remove('stop');
    btnSendMessage.title = '發送訊息';
    btnSendMessage.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
    `;

    const indicator = document.querySelector('.mini-pet-indicator');
    if (indicator) {
      indicator.className = 'mini-pet-indicator status-online';
    }
    if (chatPetStatusText) chatPetStatusText.textContent = 'Ready to help you';

    // Remove any leftover cursor
    const cursors = document.querySelectorAll('.typing-cursor');
    cursors.forEach(c => c.remove());
  }

  function appendMessage(role, content) {
    const msg = document.createElement('div');
    msg.className = `message ${role}`;

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    if (role === 'user') {
      msg.innerHTML = `
        <div class="message-avatar">YOU</div>
        <div class="message-body">
          <div class="message-content">${escapeHtml(content)}</div>
          <div class="message-meta">${timeStr}</div>
        </div>
      `;
    }
    chatMessages.appendChild(msg);
    scrollToBottom();
  }

  function createAssistantMessageElement() {
    const msg = document.createElement('div');
    msg.className = 'message assistant';

    const emojiMap = { kitsune: '🦊', shiba: '🐕', cat: '🐱', slime: '✨' };
    const avatarEmoji = emojiMap[pet.skin] || '🦊';

    msg.innerHTML = `
      <div class="message-avatar">${avatarEmoji}</div>
      <div class="message-body">
        <div class="message-content"><span class="typing-cursor"></span></div>
        <div class="message-meta">剛剛</div>
      </div>
    `;
    return msg;
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Lightweight Markdown & Code Block Formatter
  function formatMarkdown(text) {
    if (!text) return '';

    // Code Blocks: ```lang ... ```
    let formatted = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const escapedCode = escapeHtml(code.trim());
      const langLabel = lang || 'code';
      return `
        <div class="code-block-wrapper">
          <div class="code-block-header">
            <span class="code-lang">${langLabel}</span>
            <button class="btn-copy-code" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(code.trim())}'))">複製代碼</button>
          </div>
          <pre><code>${escapedCode}</code></pre>
        </div>
      `;
    });

    // Inline Code: `code`
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **bold**
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Blockquote: > text
    formatted = formatted.replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>');

    // Bullet points: - text
    formatted = formatted.replace(/^-\s+(.+)$/gm, '• $1<br>');

    // Paragraph line breaks
    formatted = formatted.replace(/\n\n/g, '</p><p>');
    formatted = formatted.replace(/\n/g, '<br>');

    return `<p>${formatted}</p>`;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }


  // ----------------------------------------------------------------
  // 3. Settings Modal Controller
  // ----------------------------------------------------------------
  function openSettings() {
    // Populate form with current values
    selectAiProvider.value = ai.provider;
    inputApiKey.value = ai.apiKey;
    inputBaseUrl.value = ai.baseUrl;
    inputModelName.value = ai.modelName;
    inputSystemPrompt.value = ai.systemPrompt;
    inputPetNickname.value = pet.nickname;
    inputUserTitle.value = pet.userTitle;

    checkPetSound.checked = pet.soundEnabled;
    checkAutoSpeech.checked = pet.autoSpeech;

    // Roaming lives in the main process (tray can change it too).
    if (window.electronAPI && window.electronAPI.getRoamEnabled) {
      window.electronAPI.getRoamEnabled().then((enabled) => {
        checkRoam.checked = enabled !== false;
      }).catch(() => {});
    }

    // Check matching skin radio
    const skinRadio = document.querySelector(`input[name="petSkin"][value="${pet.skin}"]`);
    if (skinRadio) skinRadio.checked = true;

    handleProviderFormVisibility();
    document.querySelector('.modal-body').scrollTop = 0;
    settingsModal.classList.remove('hidden');
    if (window.electronAPI && window.electronAPI.setUiBusy) {
      window.electronAPI.setUiBusy(true);
    }
  }

  function closeSettings() {
    if (settingsModal.classList.contains('hidden')) return;
    settingsModal.classList.add('hidden');
    if (window.electronAPI && window.electronAPI.setUiBusy) {
      window.electronAPI.setUiBusy(false);
    }
  }

  btnQuickSettings.addEventListener('click', openSettings);
  btnChatSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', closeSettings);

  // Tab switching inside Settings
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.dataset.tab;
      document.getElementById(targetId).classList.add('active');
      document.querySelector('.modal-body').scrollTop = 0;
      if (targetId === 'tab-pet') {
        const checked = document.querySelector('input[name="petSkin"]:checked');
        checked?.closest('.skin-card')?.scrollIntoView({ block: 'nearest' });
      }
    });
  });

  // In the pet-sized window the scrollable body is a narrow strip; let the
  // wheel scroll it from anywhere in the dialog instead of silently doing nothing.
  settingsModal.addEventListener('wheel', (e) => {
    const body = document.querySelector('.modal-body');
    if (body.contains(e.target)) return;
    body.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // Dynamic Provider Visibility & Placeholders
  function handleProviderFormVisibility() {
    const val = selectAiProvider.value;
    const keyGroup = document.getElementById('group-api-key');
    const baseGroup = document.getElementById('group-base-url');
    const modelGroup = document.getElementById('group-model-name');

    if (val === 'builtin') {
      keyGroup.style.display = 'none';
      baseGroup.style.display = 'none';
      modelGroup.style.display = 'none';
    } else {
      keyGroup.style.display = val === 'ollama' ? 'none' : 'block';
      baseGroup.style.display = 'block';
      modelGroup.style.display = 'block';

      if (val === 'openai') {
        inputBaseUrl.placeholder = 'https://api.openai.com/v1';
        inputModelName.placeholder = 'gpt-4o-mini';
      } else if (val === 'gemini') {
        inputBaseUrl.placeholder = 'https://generativelanguage.googleapis.com';
        inputModelName.placeholder = 'gemini-1.5-flash';
      } else if (val === 'claude') {
        inputBaseUrl.placeholder = 'https://api.anthropic.com/v1';
        inputModelName.placeholder = 'claude-3-5-sonnet-20241022';
      } else if (val === 'ollama') {
        inputBaseUrl.placeholder = 'http://localhost:11434';
        inputModelName.placeholder = 'llama3';
      } else if (val === 'custom') {
        inputBaseUrl.placeholder = 'https://api.deepseek.com/v1';
        inputModelName.placeholder = 'deepseek-chat';
      }
    }
  }

  selectAiProvider.addEventListener('change', handleProviderFormVisibility);

  // Toggle API Key visibility
  btnToggleKeyVisibility.addEventListener('click', () => {
    if (inputApiKey.type === 'password') {
      inputApiKey.type = 'text';
      btnToggleKeyVisibility.textContent = '🔒';
    } else {
      inputApiKey.type = 'password';
      btnToggleKeyVisibility.textContent = '👁️';
    }
  });

  // Pet Scale Slider
  sliderPetScale.addEventListener('input', (e) => {
    const scale = parseInt(e.target.value, 10) / 100;
    const petGraphic = document.getElementById('pet-graphic');
    if (petGraphic) petGraphic.style.transform = `scale(${scale})`;
  });

  // Opacity Slider
  sliderOpacity.addEventListener('input', (e) => {
    const op = e.target.value;
    valOpacity.textContent = `${op}%`;
    document.documentElement.style.setProperty('--bg-glass', `rgba(15, 18, 28, ${op / 100})`);
  });

  // Skin Radio Live Switch
  const skinRadios = document.querySelectorAll('input[name="petSkin"]');
  const sectionCustomPhoto = document.getElementById('section-custom-photo');
  const inputPetPhoto = document.getElementById('input-pet-photo');
  const photoDropZone = document.getElementById('photo-drop-zone');
  const uploadPlaceholder = document.getElementById('upload-placeholder');
  const photoPreviewContainer = document.getElementById('photo-preview-container');
  const photoPreviewImg = document.getElementById('photo-preview-img');
  const btnRemovePhoto = document.getElementById('btn-remove-photo');
  const selectPhotoFrame = document.getElementById('select-photo-frame');
  const inputPetSpecies = document.getElementById('input-pet-species');
  const inputRealPetHabits = document.getElementById('input-real-pet-habits');
  const customSkinPreviewEmoji = document.getElementById('custom-skin-preview-emoji');

  function updateCustomPhotoUI() {
    const savedPhoto = localStorage.getItem('aurapet_custom_photo');
    const savedFrame = localStorage.getItem('aurapet_custom_frame') || 'aura-contour';
    const savedSpecies = localStorage.getItem('aurapet_pet_species') || '';
    const savedHabits = localStorage.getItem('aurapet_pet_habits') || '';

    selectPhotoFrame.value = savedFrame;
    inputPetSpecies.value = savedSpecies;
    inputRealPetHabits.value = savedHabits;

    if (savedPhoto) {
      photoPreviewImg.src = savedPhoto;
      photoPreviewContainer.classList.remove('hidden');
      uploadPlaceholder.classList.add('hidden');
      if (customSkinPreviewEmoji) customSkinPreviewEmoji.textContent = '🐶';
    } else {
      photoPreviewContainer.classList.add('hidden');
      uploadPlaceholder.classList.remove('hidden');
      if (customSkinPreviewEmoji) customSkinPreviewEmoji.textContent = '📸';
    }
  }

  // Handle Photo File Upload
  function handlePhotoFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      alert('請上傳圖片格式檔案 (JPG, PNG, WebP)！');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Data = e.target.result;
      localStorage.setItem('aurapet_custom_photo', base64Data);
      updateCustomPhotoUI();

      // If custom_photo is selected, immediately render
      const checkedSkin = document.querySelector('input[name="petSkin"]:checked');
      if (checkedSkin && checkedSkin.value === 'custom_photo') {
        pet.setSkin('custom_photo');
      }
    };
    reader.readAsDataURL(file);
  }

  if (inputPetPhoto) {
    inputPetPhoto.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handlePhotoFile(e.target.files[0]);
      }
    });
  }

  if (btnRemovePhoto) {
    btnRemovePhoto.addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.removeItem('aurapet_custom_photo');
      updateCustomPhotoUI();
      pet.renderSkin();
    });
  }

  // Drag & drop support on upload zone
  if (photoDropZone) {
    photoDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      photoDropZone.classList.add('dragover');
    });
    photoDropZone.addEventListener('dragleave', () => {
      photoDropZone.classList.remove('dragover');
    });
    photoDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      photoDropZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handlePhotoFile(e.dataTransfer.files[0]);
      }
    });
  }

  updateCustomPhotoUI();

  skinRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      pet.setSkin(radio.value);
    });
  });

  // Save Settings
  btnSaveSettings.addEventListener('click', () => {
    const checkedSkin = document.querySelector('input[name="petSkin"]:checked');
    const selectedSkin = checkedSkin ? checkedSkin.value : pet.skin;
    const petName = inputPetNickname.value.trim() || 'Lumi';
    const userTitle = inputUserTitle.value.trim() || '主人';

    // 1. Save Real Pet Customization
    localStorage.setItem('aurapet_custom_frame', selectPhotoFrame.value);
    localStorage.setItem('aurapet_pet_species', inputPetSpecies.value.trim());
    localStorage.setItem('aurapet_pet_habits', inputRealPetHabits.value.trim());

    // 2. Customize System Prompt if real pet is selected
    let customSystemPrompt = inputSystemPrompt.value.trim();
    if (selectedSkin === 'custom_photo') {
      const species = inputPetSpecies.value.trim() || '寵物毛小孩';
      const habits = inputRealPetHabits.value.trim();
      customSystemPrompt = `你是${userTitle}最心愛的真實寵物【${petName}】（品種：${species}）。性格與生活習慣：${habits || '撒嬌、親人、可愛'}。請用${petName}的身份、第一人稱、充滿愛意與可愛寵物語氣陪伴${userTitle}說話、解答問題！`;
    }

    // 3. Save AI Config
    ai.saveConfig({
      provider: selectAiProvider.value,
      apiKey: inputApiKey.value.trim(),
      baseUrl: inputBaseUrl.value.trim(),
      modelName: inputModelName.value.trim(),
      systemPrompt: customSystemPrompt
    });

    // 4. Save Pet Config
    pet.setSkin(selectedSkin);
    pet.setNickname(petName);
    pet.setUserTitle(userTitle);
    pet.soundEnabled = checkPetSound.checked;
    pet.autoSpeech = checkAutoSpeech.checked;
    localStorage.setItem('aurapet_sound', pet.soundEnabled.toString());
    localStorage.setItem('aurapet_speech', pet.autoSpeech.toString());

    // 5. System Options
    if (window.electronAPI && window.electronAPI.setAlwaysOnTop) {
      window.electronAPI.setAlwaysOnTop(checkAlwaysTop.checked);
    }
    if (window.electronAPI && window.electronAPI.setRoamEnabled) {
      window.electronAPI.setRoamEnabled(checkRoam.checked);
    }

    updateModelBadgeDisplay();
    closeSettings();
    pet.playSound('pat');
    pet.say(`設定已保存！我是你的專屬夥伴 ${petName} 🐾`, 3000);
  });

  // Reset Settings
  btnResetSettings.addEventListener('click', () => {
    if (confirm('確定要恢復預設設定嗎？')) {
      if (window.electronAPI && window.electronAPI.setRoamEnabled) {
        window.electronAPI.setRoamEnabled(false);
      }
      localStorage.clear();
      location.reload();
    }
  });
});
