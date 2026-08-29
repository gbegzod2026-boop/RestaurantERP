// escapeHtml — Production Security Fix Pass (Critical): chat/announcement
// text and author fields come straight from Firebase (any staff member,
// including low-privilege roles, can write them) and were previously
// interpolated straight into innerHTML — a classic stored-XSS hole where
// one account's message executes script in every other viewer's browser
// (including admin/superadmin). Every user-authored field must go through
// this before being placed inside an innerHTML template string.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

window.injectChatStyles = function () {
  if (document.getElementById("chatSystemStyles")) return;
  const style = document.createElement("style");
  style.id = "chatSystemStyles";
  style.textContent = `
    .chat-fab { position: fixed; bottom: 30px; right: 30px; width: 60px; height: 60px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; border-radius: 50%; cursor: pointer; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); display: flex; align-items: center; justify-content: center; font-size: 24px; z-index: 999; transition: all 0.3s ease; }
    .chat-fab:hover { transform: scale(1.1); box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4); }
    .chat-fab.active { background: linear-gradient(135deg, #764ba2 0%, #667eea 100%); }
    .chat-modal { position: fixed; bottom: 100px; right: 30px; width: 360px; height: 500px; background: white; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; z-index: 1000; overflow: hidden; animation: slideUp 0.3s ease; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 480px) { .chat-modal { width: calc(100vw - 20px); height: calc(100vh - 100px); bottom: 60px; right: 10px; left: 10px; } .chat-fab { bottom: 15px; right: 15px; width: 50px; height: 50px; font-size: 20px; } }
    .chat-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; flex-shrink: 0; }
    .chat-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .chat-close-btn { background: none; border: none; color: white; font-size: 20px; cursor: pointer; padding: 0; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; transition: transform 0.2s; }
    .chat-close-btn:hover { transform: rotate(90deg); }
    .chat-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .chat-selection { flex: 1; display: flex; flex-direction: column; padding: 20px; overflow-y: auto; }
    .chat-selection-title { font-size: 14px; color: #666; margin-bottom: 12px; font-weight: 500; }
    .chat-option { padding: 12px 16px; margin-bottom: 10px; background: #f5f5f5; border: 2px solid transparent; border-radius: 8px; cursor: pointer; font-size: 14px; color: #333; transition: all 0.3s ease; display: flex; align-items: center; gap: 10px; }
    .chat-option:hover { background: #efefef; border-color: #667eea; transform: translateX(4px); }
    .chat-option-icon { font-size: 18px; width: 24px; }
    .chat-messages-view { display: none; flex: 1; flex-direction: column; min-height: 0; }
    .chat-messages-view.active { display: flex; }
    .chat-back-btn { background: #f5f5f5; border: none; padding: 10px 16px; cursor: pointer; color: #667eea; font-weight: 500; font-size: 13px; border-bottom: 1px solid #eee; transition: all 0.2s; flex-shrink: 0; }
    .chat-back-btn:hover { background: #efefef; }
    .chat-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; background: #fafafa; }
    .chat-message { padding: 10px 14px; border-radius: 8px; max-width: 85%; word-wrap: break-word; font-size: 14px; animation: messageIn 0.3s ease; }
    .chat-message.sent { background: #667eea; color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
    .chat-message.received { background: white; color: #333; align-self: flex-start; border: 1px solid #e0e0e0; border-bottom-left-radius: 2px; }
    .chat-message-time { font-size: 12px; opacity: 0.7; margin-top: 4px; }
    .chat-input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #eee; background: white; flex-shrink: 0; }
    .chat-input { flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; font-family: inherit; transition: all 0.2s; }
    .chat-input:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
    .chat-send-btn { background: #667eea; border: none; color: white; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; transition: all 0.2s; }
    .chat-send-btn:hover { background: #764ba2; transform: scale(1.05); }
    .chat-send-btn:disabled { background: #ccc; cursor: not-allowed; transform: scale(1); }
    .chat-empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #999; font-size: 14px; }
    .chat-empty-state-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.5; }
    .chat-messages::-webkit-scrollbar, .chat-selection::-webkit-scrollbar { width: 6px; }
    .chat-messages::-webkit-scrollbar-track, .chat-selection::-webkit-scrollbar-track { background: transparent; }
    .chat-messages::-webkit-scrollbar-thumb, .chat-selection::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
    .chat-fab { font-size: 0; width: 56px; height: 56px; background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); box-shadow: 0 8px 24px rgba(37, 99, 235, 0.45); }
    .chat-fab::before { content: ""; width: 28px; height: 28px; display: block; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M12 2C6.477 2 2 6.145 2 11.243c0 2.936 1.46 5.56 3.755 7.28L5 21.5l3.5-1.457C9.563 20.66 10.762 21 12 21c5.523 0 10-4.145 10-9.243S17.523 2 12 2zm-3 10.5a1 1 0 110-2 1 1 0 010 2zm3 0a1 1 0 110-2 1 1 0 010 2zm3 0a1 1 0 110-2 1 1 0 010 2z'/%3E%3C/svg%3E") center / contain no-repeat; }
    .chat-fab:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 12px 28px rgba(37, 99, 235, 0.55); }
    .chat-fab.active { background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%); }
    .chat-modal { border: 1px solid #dde7e1; border-radius: 14px; box-shadow: 0 24px 52px rgba(19, 46, 34, 0.16); }
    .chat-header { background: linear-gradient(135deg, #0d1712, #123325); border-bottom-color: rgba(231, 246, 239, 0.1); }

    .chat-header h3 { flex: 1; }
    .chat-option { background: #f5f8f6; border: 1px solid #dde7e1; border-radius: 12px; }
    .chat-option:hover { background: #e7f6ef; border-color: rgba(22, 138, 95, 0.34); transform: translateX(3px); }
    .chat-messages { background: linear-gradient(180deg, #f8fbf9 0%, #f2f7f4 100%); gap: 10px; }
    .chat-message { border-radius: 14px; box-shadow: 0 8px 18px rgba(19, 46, 34, 0.06); }
    .chat-message.sent { background: linear-gradient(135deg, #168a5f, #0f6f4d); color: #fff; border-bottom-right-radius: 5px; }
    .chat-message.received { background: #fff; color: #17211c; border-color: #dde7e1; border-bottom-left-radius: 5px; }
    .chat-input:focus { border-color: #168a5f; box-shadow: 0 0 0 4px rgba(22, 138, 95, 0.14); }
    .chat-send-btn { background: linear-gradient(135deg, #168a5f, #0f6f4d); }
    .chat-send-btn:hover { background: linear-gradient(135deg, #1a9b6b, #0f6f4d); }
  `;
  document.head.appendChild(style);
};

window.injectChatHTML = function () {
  // Agar modal hozir ochiq bo'lsa — HTMLni qayta yaratmaymiz
  const existingModal = document.getElementById("chatModal");
  if (existingModal && existingModal.style.display === "flex") {
    return false; // ochiq — o'tkazib yuborish
  }

  const oldFab = document.getElementById("chatFab");
  if (oldFab) oldFab.remove();
  if (existingModal) existingModal.remove();
  const chatHTML = `
    <button class="chat-fab" id="chatFab" title="Chat"></button>
    <div class="chat-modal" id="chatModal">
      <div class="chat-header">
        <h3 id="chatHeader">💬 ${t("chat_title", "Xabarlar")}</h3>
        <button class="chat-close-btn" id="chatCloseBtn">✕</button>
      </div>
      <div class="chat-content">
        <div class="chat-selection" id="chatSelection">
          <div class="chat-selection-title" id="chatSelectionTitle">
    ${t("chat_selection_title", "Tanlang:")}
</div>
          <div id="chatOptionsList"></div>
        </div>
        <div class="chat-messages-view" id="chatMessagesView">
          <button class="chat-back-btn" id="chatBackBtn"> ${t("chat_back_btn", "Orqaga")}</button>
          <div class="chat-messages" id="chatMessages"></div>
        </div>
      </div>
      <div class="chat-input-area" id="chatInputArea" style="display: none;">
        <input type="text" class="chat-input" id="chatInput" placeholder="${t("chat_input_placeholder", "Xabar yozing...")}" autocomplete="off" />
        <button class="chat-send-btn" id="chatSendBtn">➤</button>
      </div>
    </div>
  `;
  document.getElementById("chatFab")?.remove();
  document.getElementById("chatModal")?.remove();
  document.body.insertAdjacentHTML("beforeend", chatHTML);
};


// ===============================================
// ASOSIY CHAT FUNKSIYASI (HAMMASI BUNI ICHIDA)
// ===============================================
window.initChatSystem = async function (config) {
  window._chatSystemLastConfig = config;

  const { ref, push, update, onChildAdded, onValue } = await import("./pgRtdb.js");

  const { currentRestaurantId, currentUserId, currentRole, db, getChatOptions, getChatId } = config;

  window.injectChatStyles();
  const htmlInjected = window.injectChatHTML();

  // Agar modal ochiq bo'lsa (injectChatHTML false qaytargan) — faqat matnlarni yangilaymiz
  if (htmlInjected === false) {
    window.updateChatTexts();
    return;
  }

  const chatFab = document.getElementById("chatFab");
  const chatModal = document.getElementById("chatModal");
  const chatCloseBtn = document.getElementById("chatCloseBtn");
  const chatSelection = document.getElementById("chatSelection");
  const chatMessagesView = document.getElementById("chatMessagesView");
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");
  const chatBackBtn = document.getElementById("chatBackBtn");
  const chatInputArea = document.getElementById("chatInputArea");
  const chatOptionsList = document.getElementById("chatOptionsList");
  const chatHeader = document.getElementById("chatHeader");

  let currentChatId = null;
  let currentChatMode = "default"; // "default" | "announcement" | "superadmin"
  let messagesListener = null;

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  if (!chatFab) return;

  chatFab.addEventListener("click", () => {
    if (chatModal.style.display === "flex") closeChatModal();
    else openChatModal();
  });

  chatCloseBtn.addEventListener("click", closeChatModal);

  function closeChatModal() {
    chatModal.style.display = "none";
    chatFab.classList.remove("active");
    if (messagesListener) {
      messagesListener();
      messagesListener = null;
    }
  }

  function openChatModal() {
    chatModal.style.display = "flex";
    chatFab.classList.add("active");
    showSelectionView();
  }

  window._chatShowSelectionView = showSelectionView;

  async function showSelectionView() {
    chatSelection.style.display = "flex";
    chatMessagesView.classList.remove("active");
    chatInputArea.style.display = "none";
    currentChatId = null;
    chatOptionsList.innerHTML = "";

    const options = await getChatOptions(currentUserId, currentRestaurantId);

    if (!options || options.length === 0) {
      chatOptionsList.innerHTML = `<div class="chat-empty-state"><div class="chat-empty-state-icon">📭</div><div>${t("chat_no_options", "Tanlovlar topilmadi")}</div></div>`;
      return;
    }

    options.forEach((option) => {
      const optionEl = document.createElement("div");
      optionEl.className = "chat-option";
      optionEl.innerHTML = `<span class="chat-option-icon">${option.icon}</span><span>${option.label}</span>`;
      optionEl.addEventListener("click", () => openChat(option));
      chatOptionsList.appendChild(optionEl);
    });
  }

  async function openChat(option) {
    if (option.type === "announcement") {
      await openAnnouncementView(option);
      return;
    }

    const chatId = await getChatId(option, currentUserId, currentRestaurantId);
    if (chatId === "RELOAD_MENU") {
      showSelectionView();
      return;
    }
    if (!chatId) return;

    currentChatId = chatId;
    currentChatMode = option.type === "superadmin" ? "superadmin" : "default";
    chatSelection.style.display = "none";
    chatMessagesView.classList.add("active");
    chatInputArea.style.display = "flex";
    chatInput.placeholder = t("chat_input_placeholder", "Xabar yozing...");
    chatBackBtn.textContent = `← ${t("chat_back_btn", "Orqaga")}`;
    chatInput.focus();
    chatHeader.textContent = `💬 ${option.label}`;

    chatMessages.innerHTML = "";
    listenForNewMessages();
  }

  // 📢 E'lonlar — barcha xodimlar o'qiydi, faqat admin yozadi
  async function openAnnouncementView(option) {
    currentChatId = "announcement";
    currentChatMode = "announcement";
    chatSelection.style.display = "none";
    chatMessagesView.classList.add("active");
    chatBackBtn.textContent = `← ${t("chat_back_btn", "Orqaga")}`;
    chatHeader.textContent = `📢 ${option.label}`;
    chatMessages.innerHTML = "";

    const canPost = currentRole === "admin";
    chatInputArea.style.display = canPost ? "flex" : "none";
    if (canPost) {
      chatInput.placeholder = t("ann_post_placeholder", "E'lon yozing...");
      chatInput.focus();
    }

    if (messagesListener) {
      messagesListener();
      messagesListener = null;
    }

    const dateKey = todayKey();
    const annRef = ref(db, `restaurants/${currentRestaurantId}/kitchenAnnouncements/${dateKey}`);

    messagesListener = onValue(annRef, (snap) => {
      chatMessages.innerHTML = "";
      const data = snap.val() || {};
      const entries = Object.entries(data).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

      if (entries.length === 0) {
        chatMessages.innerHTML = `<div class="chat-empty-state"><div class="chat-empty-state-icon">📢</div><div>${t("ann_empty", "Hozircha e'lonlar yo'q")}</div></div>`;
        return;
      }

      entries.forEach(([annId, ann]) => {
        const isMine = ann.createdBy === currentUserId;
        const el = document.createElement("div");
        el.className = `chat-message ${isMine ? "sent" : "received"}`;
        const timeStr = new Date(ann.createdAt || Date.now()).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
        const authorLine = !isMine ? `<div style="font-weight:600; font-size:12px; opacity:.75; margin-bottom:2px;">${escapeHtml(ann.author)}</div>` : "";
        el.innerHTML = `${authorLine}<div>${escapeHtml(ann.text)}</div><div class="chat-message-time">${timeStr}</div>`;
        chatMessages.appendChild(el);

        if (!canPost && (!ann.readBy || !ann.readBy[currentUserId])) {
          update(ref(db, `restaurants/${currentRestaurantId}/kitchenAnnouncements/${dateKey}/${annId}/readBy`), { [currentUserId]: true }).catch(() => {});
        }
      });

      setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50);
    });
  }

  function listenForNewMessages() {
    if (messagesListener) {
      messagesListener();
      messagesListener = null;
    }

    if (currentChatMode === "superadmin") {
      const chatRef = ref(db, `restaurants/${currentRestaurantId}/superadmin_chat`);
      messagesListener = onValue(chatRef, (snap) => {
        chatMessages.innerHTML = "";
        const msgs = snap.val();
        if (msgs) {
          Object.values(msgs)
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
            .forEach((m) => {
              const isSent = m.sender === "admin";
              const el = document.createElement("div");
              el.className = `chat-message ${isSent ? "sent" : "received"}`;
              const timeStr = new Date(m.timestamp || Date.now()).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
              el.innerHTML = `<div>${escapeHtml(m.text)}</div><div class="chat-message-time">${timeStr}</div>`;
              chatMessages.appendChild(el);
            });
        }
        setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50);
      });
      return;
    }

    const messagesRef = ref(db, `restaurants/${currentRestaurantId}/chats/${currentChatId}/messages`);

    messagesListener = onChildAdded(messagesRef, (snapshot) => {
      appendMessage(snapshot.val());
      setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50);
    });
  }

  function appendMessage(msg) {
    if (!msg) return;
    console.log("💬 MSG DEBUG | senderId:", msg.senderId, "| myId:", currentUserId, "| match:", String(msg.senderId).trim() === String(currentUserId).trim());
    const isSent = String(msg.senderId).trim() === String(currentUserId).trim();
    const messageEl = document.createElement("div");
    messageEl.className = `chat-message ${isSent ? "sent" : "received"}`;

    const timeVal = msg.timestamp || msg.createdAt || Date.now();
    const timeStr = new Date(timeVal).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });

    messageEl.innerHTML = `<div>${escapeHtml(msg.text)}</div><div class="chat-message-time">${timeStr}</div>`;
    chatMessages.appendChild(messageEl);
  }

  // 3. MUHIM: sendMessage endi scope dan chiqib ketmadi
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentChatId) return;

    chatInput.value = "";
    chatSendBtn.disabled = true;
    const now = Date.now();

    try {
      if (currentChatMode === "announcement") {
        if (currentRole !== "admin") { chatSendBtn.disabled = false; return; }
        await push(ref(db, `restaurants/${currentRestaurantId}/kitchenAnnouncements/${todayKey()}`), {
          text: text,
          author: localStorage.getItem("name") || t("head_admin", "Bosh Admin"),
          createdAt: now,
          createdBy: currentUserId,
          readBy: {}
        });
      } else if (currentChatMode === "superadmin") {
        await push(ref(db, `restaurants/${currentRestaurantId}/superadmin_chat`), {
          sender: currentRole === "admin" ? "admin" : "superadmin",
          text: text,
          timestamp: now
        });
      } else {
        const messagesRef = ref(db, `restaurants/${currentRestaurantId}/chats/${currentChatId}/messages`);

        await push(messagesRef, {
          text: text,
          senderId: currentUserId,
          senderRole: currentRole,
          senderName: localStorage.getItem("name") || "Foydalanuvchi",
          timestamp: now,
          createdAt: now
        });

        const metaRef = ref(db, `restaurants/${currentRestaurantId}/chats/${currentChatId}/meta`);
        await update(metaRef, {
          updatedAt: now,
          lastMessage: text,
          lastSenderId: currentUserId,
          lastSenderRole: currentRole
        });
      }

      chatSendBtn.disabled = false;
      chatInput.focus();
    } catch (error) {
      console.error("Xatolik:", error);
      chatInput.value = text;
      chatSendBtn.disabled = false;
    }
  }

  chatSendBtn.addEventListener("click", sendMessage);

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatBackBtn.addEventListener("click", showSelectionView);

  chatModal.addEventListener("click", (e) => {
    if (e.target === chatModal) closeChatModal();
  });

};

window.generateChatId = function (userId1, userId2, prefix = "") {
  const ids = [userId1, userId2].sort();
  return prefix ? `${prefix}_${ids[0]}_${ids[1]}` : `${ids[0]}_${ids[1]}`;
};

window.formatChatPath = function (restaurantId, chatId) {
  return `restaurants/${restaurantId}/chats/${chatId}`;
};

// Faqat matnlarni yangilash — modal holatini o'zgartirmaydi
window.updateChatTexts = function () {
  const chatHeader = document.getElementById("chatHeader");
  const chatSelectionTitle = document.querySelector(".chat-selection-title");
  const chatBackBtn = document.getElementById("chatBackBtn");
  const chatInput = document.getElementById("chatInput");

  // Agar hozir alohida chat ochiq bo'lsa, sarlavhani o'zgartirmaymiz
  const messagesView = document.getElementById("chatMessagesView");
  const isInChat = messagesView && messagesView.classList.contains("active");

  if (chatHeader && !isInChat) {
    chatHeader.textContent = `💬 ${t("chat_title", "Xabarlar")}`;
  }
  if (chatSelectionTitle) {
    chatSelectionTitle.textContent = t("chat_selection_title", "Tanlang:");
  }
  if (chatBackBtn) {
    chatBackBtn.textContent = `← ${t("chat_back_btn", "Orqaga")}`;
  }
  if (chatInput) {
    chatInput.placeholder = t("chat_input_placeholder", "Xabar yozing...");
  }

  // Agar selection view ochiq bo'lsa — variantlarni ham qayta yuklaymiz (til tarjimasi uchun)
  if (!isInChat && typeof window._chatShowSelectionView === "function") {
    window._chatShowSelectionView();
  }
};

if (typeof onLangChange === "function") {
  onLangChange(() => {
    const chatModal = document.getElementById("chatModal");
    const isOpen = chatModal && chatModal.style.display === "flex";

    if (isOpen) {
      window.updateChatTexts();
    } else if (window._chatSystemLastConfig) {
      window.initChatSystem(window._chatSystemLastConfig);
    }
  });
}