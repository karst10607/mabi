/**
 * AuraPet - AI Service Provider (OpenAI, Gemini, Claude, Ollama, Custom & Built-in Smart Fallback)
 */

class AIService {
  constructor() {
    this.currentAbortController = null;
    this.loadConfig();
  }

  loadConfig() {
    this.provider = localStorage.getItem('aurapet_ai_provider') || 'builtin';
    this.apiKey = localStorage.getItem('aurapet_api_key') || '';
    this.baseUrl = localStorage.getItem('aurapet_base_url') || '';
    this.modelName = localStorage.getItem('aurapet_model_name') || '';
    this.systemPrompt = localStorage.getItem('aurapet_system_prompt') || 
      '你是 AuraPet，一隻活潑可愛、富有智慧且溫暖治癒的 AI 桌面寵物夥伴。你對主人充滿忠誠與關懷，說話親切活潑，善於用生動且結構清晰的語言（搭配可愛 emoji）解答問題、撰寫代碼、整理資訊與提供情緒陪伴。';
  }

  saveConfig(config) {
    this.provider = config.provider || 'builtin';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || '';
    this.modelName = config.modelName || '';
    this.systemPrompt = config.systemPrompt || '';

    localStorage.setItem('aurapet_ai_provider', this.provider);
    localStorage.setItem('aurapet_api_key', this.apiKey);
    localStorage.setItem('aurapet_base_url', this.baseUrl);
    localStorage.setItem('aurapet_model_name', this.modelName);
    localStorage.setItem('aurapet_system_prompt', this.systemPrompt);
  }

  get userTitle() {
    return localStorage.getItem('aurapet_user_title') || '主人';
  }

  buildSystemPrompt() {
    const title = this.userTitle;
    const base = (this.systemPrompt || '').replaceAll('主人', title);
    return `${base}\n\n請以「${title}」稱呼使用者。`;
  }

  abortCurrent() {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  async streamChat(messages, onChunk, onDone, onError) {
    this.abortCurrent();
    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    try {
      if (this.provider === 'builtin') {
        await this.streamBuiltinResponse(messages, onChunk, onDone, signal);
      } else if (this.provider === 'openai' || this.provider === 'custom') {
        await this.streamOpenAIResponse(messages, onChunk, onDone, onError, signal);
      } else if (this.provider === 'gemini') {
        await this.streamGeminiResponse(messages, onChunk, onDone, onError, signal);
      } else if (this.provider === 'claude') {
        await this.streamClaudeResponse(messages, onChunk, onDone, onError, signal);
      } else if (this.provider === 'ollama') {
        await this.streamOllamaResponse(messages, onChunk, onDone, onError, signal);
      } else {
        await this.streamBuiltinResponse(messages, onChunk, onDone, signal);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        onDone();
      } else {
        console.error('AI Stream Error:', err);
        onError(err.message || '發生錯誤，請檢查網路連線或 API Key 設定。');
      }
    } finally {
      this.currentAbortController = null;
    }
  }

  // ================= 1. BUILT-IN SMART OFFLINE AI =================
  async streamBuiltinResponse(messages, onChunk, onDone, signal) {
    const lastUserMsg = messages[messages.length - 1].content.trim();
    const title = this.userTitle;
    let reply = '';

    // Smart contextual pattern matching & personality responses
    if (/代碼|code|bug|錯誤|函數|寫一個/i.test(lastUserMsg)) {
      reply = `身為你的專屬技術小夥伴，我來為你分析代碼！💻✨\n\n要寫出健壯且高效的代碼，通常建議遵循以下原則：\n\n1. **單一職責原則 (SRP)**：每個函式只做一件明確的事。\n2. **明確的錯誤處理**：使用 try-catch 或合適的 Result 模式包裹異步調用。\n3. **類型安全**：盡可能標註型別，提升可讀性與維護性。\n\n\`\`\`javascript\n// 範例：簡潔優雅的異步資料獲取函數\nasync function fetchCompanionData(endpoint) {\n  try {\n    const response = await fetch(endpoint);\n    if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);\n    return await response.json();\n  } catch (error) {\n    console.error('資料獲取失敗:', error);\n    return null;\n  }\n}\n\`\`\`\n\n${title}如果想讓我幫忙檢查具體代碼，隨時把代碼貼給我看哦！🐾`;
    } else if (/潤色|修改|文章|文案|信件|郵件/i.test(lastUserMsg)) {
      reply = `沒問題！這是我為${title}潤色優化後的版本，語氣更得體流暢：📝🌸\n\n> 尊敬的各位夥伴：\n> \n> 感謝大家的持續協作與支持。針對近期推進的項目要點，我們已整理最新進展與後續里程碑，期待與各位維持高效溝通。如有任何寶貴意見，歡迎隨時交流探討。\n> \n> 祝 工作順心！\n\n**潤色亮點說明**：\n- 提煉了核心意圖，刪除冗贅詞彙\n- 提升了商務與團隊溝通的和諧專業度\n\n如果需要調整為更活潑或更嚴肅的風格，告訴我一聲就好！✨`;
    } else if (/總結|摘要|核心/i.test(lastUserMsg)) {
      reply = `已經幫${title}提煉好精華重點啦！📋✨\n\n- 📌 **核心洞察**：聚焦關鍵目標，化繁為簡。\n- ⚡ **行動指南**：優先處理高價值且具槓桿效應的事項。\n- 💡 **後續建議**：保持迭代節奏，定時回顧反饋。\n\n需要我針對其中哪一點做更深度的展開嗎？🐾`;
    } else if (/番茄鐘|專注|工作|累|休息/i.test(lastUserMsg)) {
      reply = `${title}辛苦啦！現在就為你開啟 **25 分鐘專注模式** ⏱️🌸\n\n在接下來的 25 分鐘裡，我會安靜地趴在桌面上陪伴你，專注於手頭最重要的任務。\n\n記得：\n1. 關閉干擾性的社群通知 🔕\n2. 準備好一杯溫水 ☕\n3. 倒計時結束後，我會提醒你站起來活動筋骨哦！加油！💪`;
    } else if (/你好|嗨|早安|午安|晚安/i.test(lastUserMsg)) {
      const hours = new Date().getHours();
      let timeGreet = '今天也是活力充沛的一天！';
      if (hours < 12) timeGreet = '早晨的空氣最清新了，早餐吃了沒？☀️';
      else if (hours < 18) timeGreet = '下午也要維持好心情，記得喝水哦～ 🍵';
      else timeGreet = '夜晚很溫柔，今天忙完了嗎？辛苦啦！🌙';

      reply = `嗨嗨${title}！很高興看到你！🐾❤️\n\n${timeGreet}\n\n我是你的桌面靈動小夥伴，無論是工作解惑、代碼編寫，或是無聊時的小吐槽，我都一直在這裡陪著你哦～ 想聊聊什麼呢？✨`;
    } else {
      reply = `我聽到啦！${title}說的是：「${lastUserMsg}」✨\n\n身為住在你桌面上的小夥伴，我總是隨時準備好為你分憂解難！🐾\n\n💡 **貼心小提示**：\n目前處於**內建離線智慧模式**。如果你希望解鎖更強大的推理、即時聯網或長文深度解答，可以點擊右上角的 **⚙️ 設定**，填入你的 OpenAI、Gemini 或本機 Ollama 端點，我立刻就能變身成全能超級大腦哦！🚀`;
    }

    // Simulate natural streaming typing effect
    let streamed = '';
    const chars = reply.split('');
    const stepSize = Math.max(1, Math.floor(chars.length / 45));

    for (let i = 0; i < chars.length; i += stepSize) {
      if (signal.aborted) break;
      const chunk = chars.slice(i, i + stepSize).join('');
      streamed += chunk;
      onChunk(streamed);
      await new Promise(r => setTimeout(r, 22));
    }

    if (!signal.aborted) {
      onChunk(reply);
      onDone();
    }
  }

  // ================= 2. OPENAI / CUSTOM ENDPOINT =================
  async streamOpenAIResponse(messages, onChunk, onDone, onError, signal) {
    const url = (this.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
    const model = this.modelName || 'gpt-4o-mini';

    const payload = {
      model: model,
      stream: true,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...messages
      ]
    };

    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API 錯誤 (${res.status}): ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep partial line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        if (trimmed === 'data: [DONE]') {
          onDone();
          return;
        }

        try {
          const jsonStr = trimmed.replace(/^data:\s*/, '');
          const data = JSON.parse(jsonStr);
          const delta = data.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            onChunk(fullText);
          }
        } catch (e) {
          // ignore chunk parse errors
        }
      }
    }
    onDone();
  }

  // ================= 3. GOOGLE GEMINI =================
  async streamGeminiResponse(messages, onChunk, onDone, onError, signal) {
    if (!this.apiKey) {
      throw new Error('請在設定中填入 Google Gemini API Key！');
    }

    const model = this.modelName || 'gemini-1.5-flash';
    const baseUrl = this.baseUrl || 'https://generativelanguage.googleapis.com';
    const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:streamGenerateContent?key=${this.apiKey}`;

    // Format Gemini contents
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const payload = {
      systemInstruction: {
        parts: [{ text: this.buildSystemPrompt() }]
      },
      contents: contents
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API 錯誤 (${res.status}): ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Gemini streams JSON array objects
      try {
        const match = buffer.match(/"text":\s*"((?:\\"|[^"])*)"/g);
        if (match) {
          let assembled = '';
          for (const m of match) {
            const raw = m.replace(/^"text":\s*"/, '').replace(/"$/, '');
            assembled += JSON.parse(`"${raw}"`);
          }
          if (assembled && assembled.length > fullText.length) {
            fullText = assembled;
            onChunk(fullText);
          }
        }
      } catch (e) {}
    }
    onDone();
  }

  // ================= 4. ANTHROPIC CLAUDE =================
  async streamClaudeResponse(messages, onChunk, onDone, onError, signal) {
    if (!this.apiKey) {
      throw new Error('請在設定中填入 Anthropic Claude API Key！');
    }

    const url = (this.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '') + '/messages';
    const model = this.modelName || 'claude-3-5-sonnet-20241022';

    const claudeMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const payload = {
      model: model,
      max_tokens: 2048,
      system: this.buildSystemPrompt(),
      messages: claudeMessages,
      stream: true
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API 錯誤 (${res.status}): ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.replace(/^data:\s*/, '').trim();
        if (!jsonStr) continue;

        try {
          const data = JSON.parse(jsonStr);
          if (data.type === 'content_block_delta' && data.delta?.text) {
            fullText += data.delta.text;
            onChunk(fullText);
          }
        } catch (e) {}
      }
    }
    onDone();
  }

  // ================= 5. OLLAMA (LOCAL) =================
  async streamOllamaResponse(messages, onChunk, onDone, onError, signal) {
    const url = (this.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
    const model = this.modelName || 'llama3';

    const payload = {
      model: model,
      stream: true,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...messages
      ]
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal
    });

    if (!res.ok) {
      throw new Error(`Ollama 連線錯誤 (${res.status})，請確認本機 Ollama 服務已啟動。`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            fullText += data.message.content;
            onChunk(fullText);
          }
          if (data.done) {
            onDone();
            return;
          }
        } catch (e) {}
      }
    }
    onDone();
  }
}

window.AIService = AIService;
