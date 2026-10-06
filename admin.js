import {
  auth, db, ref, onValue, get, set, remove, IS_CONFIGURED,
  signInAnonymously
} from "./firebase.js";

const DEFAULT_SETTINGS = {
  schoolName: "体育館予約",
  version: 1,
  rules: [
    { id: "default-1", startMonth: "2026-01", endMonth: "2026-12", startTime: "10:00", endTime: "13:00" },
    { id: "default-2", startMonth: "2026-01", endMonth: "2026-12", startTime: "13:00", endTime: "18:00" }
  ]
};

const els = {
  adminApp: document.querySelector("#adminApp"),
  logoutButton: document.querySelector("#logoutButton"),
  adminMonth: document.querySelector("#adminMonth"),
  reservationList: document.querySelector("#reservationList"),
  monthReservationCount: document.querySelector("#monthReservationCount"),
  aCount: document.querySelector("#aCount"),
  bCount: document.querySelector("#bCount"),
  todayCount: document.querySelector("#todayCount"),
  connectionState: document.querySelector("#connectionState"),
  ruleForm: document.querySelector("#ruleForm"),
  ruleStartMonth: document.querySelector("#ruleStartMonth"),
  ruleEndMonth: document.querySelector("#ruleEndMonth"),
  ruleStartTime: document.querySelector("#ruleStartTime"),
  ruleEndTime: document.querySelector("#ruleEndTime"),
  ruleError: document.querySelector("#ruleError"),
  ruleList: document.querySelector("#ruleList"),
  schoolNameInput: document.querySelector("#schoolNameInput"),
  saveSiteButton: document.querySelector("#saveSiteButton"),
  siteMessage: document.querySelector("#siteMessage"),
  toast: document.querySelector("#toast"),
  calendarGrid: document.querySelector("#calendarGrid"),
  calendarTitle: document.querySelector("#calendarTitle"),
  prevMonthButton: document.querySelector("#prevMonthButton"),
  nextMonthButton: document.querySelector("#nextMonthButton"),
  calendarDayReservations: document.querySelector("#calendarDayReservations")
};

const state = {
  settings: loadSettings(),
  reservations: {},
  unsubMonth: null,
  unsubSettings: null,
  currentUser: null
};

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem("gymSettings")) || structuredClone(DEFAULT_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function cacheSettings(settings) {
  localStorage.setItem("gymSettings", JSON.stringify(settings));
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function currentMonth() {
  return todayISO().slice(0, 7);
}

function formatJPDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function setError(el, message) {
  el.textContent = message || "";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));
}

async function withTimeout(promise, ms, message = "通信がタイムアウトしました。") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}


function parseMonth(month) {
  const [year, m] = month.split("-").map(Number);
  return { year, month: m };
}

function addMonths(month, delta) {
  const { year, month: m } = parseMonth(month);
  const d = new Date(year, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthReservationMap(month) {
  const raw = state.reservations?.[month] || {};
  return raw;
}

function getDateReservationItems(date) {
  const month = date.slice(0, 7);
  const courts = state.reservations?.[month]?.[date] || {};
  const items = [];

  for (const [court, slots] of Object.entries(courts || {})) {
    for (const [slotId, reservation] of Object.entries(slots || {})) {
      if (!reservation) continue;
      items.push({
        ...reservation,
        date,
        court,
        slotId
      });
    }
  }

  return items.sort((a, b) =>
    `${a.startTime} ${a.court}`.localeCompare(`${b.startTime} ${b.court}`)
  );
}

function getActiveRuleSlotsForDate(date) {
  const targetMonth = date.slice(0, 7);
  const rules = Array.isArray(state.settings.rules) ? state.settings.rules : [];
  const map = new Map();

  for (const rule of rules) {
    if (!rule?.startMonth || !rule?.endMonth || !rule?.startTime || !rule?.endTime) continue;
    if (rule.startMonth <= targetMonth && targetMonth <= rule.endMonth && rule.startTime < rule.endTime) {
      const key = `${rule.startTime}-${rule.endTime}`;
      map.set(key, key);
    }
  }
  return [...map.values()];
}

function getCalendarStatus(date) {
  const slotCount = getActiveRuleSlotsForDate(date).length;
  const reservations = getDateReservationItems(date);
  const totalPossible = slotCount * 2; // A面 + B面
  const used = reservations.length;

  if (slotCount === 0) return { type: "none", label: "設定なし", used, totalPossible };
  if (used >= totalPossible) return { type: "full", label: "空きなし", used, totalPossible };
  if (used > 0) return { type: "partial", label: "一部予約", used, totalPossible };
  return { type: "free", label: "空き", used, totalPossible };
}

function renderCalendar() {
  const month = els.adminMonth.value || currentMonth();
  const { year, month: monthNumber } = parseMonth(month);
  const firstDay = new Date(year, monthNumber - 1, 1);
  const lastDay = new Date(year, monthNumber, 0);

  els.calendarTitle.textContent = `${year}年${monthNumber}月`;

  const leading = firstDay.getDay();
  const dayCount = lastDay.getDate();
  const cells = [];

  for (let i = 0; i < leading; i++) {
    cells.push(`<div class="calendar-cell empty"></div>`);
  }

  for (let day = 1; day <= dayCount; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const status = getCalendarStatus(date);
    const selected = els.calendarDayReservations.dataset.selectedDate === date;
    const today = date === todayISO();
    const reservationItems = getDateReservationItems(date);

    const courtText = reservationItems.length
      ? reservationItems.map(x => `${x.court}面`).filter((v, i, a) => a.indexOf(v) === i).join("・")
      : "予約なし";

    cells.push(`
      <button type="button"
        class="calendar-cell ${status.type} ${selected ? "selected" : ""} ${today ? "today" : ""}"
        data-calendar-date="${date}"
        aria-label="${date} ${status.label} ${status.used}/${status.totalPossible || 0}枠"
      >
        <span class="calendar-date">${day}</span>
        <span class="calendar-status">${status.label}</span>
        <span class="calendar-count">${status.used}/${status.totalPossible || 0}</span>
        <span class="calendar-courts">${escapeHTML(courtText)}</span>
      </button>
    `);
  }

  els.calendarGrid.innerHTML = cells.join("");

  els.calendarGrid.querySelectorAll("[data-calendar-date]").forEach(button => {
    button.addEventListener("click", () => selectCalendarDate(button.dataset.calendarDate));
  });
}

function renderCalendarDayDetail(date = null) {
  if (!date) {
    els.calendarDayReservations.innerHTML = `
      <div class="calendar-detail-empty">
        <strong>日付を選択してください</strong>
        <span>カレンダーの日付をタップすると、その日の予約内容を確認できます。</span>
      </div>`;
    return;
  }

  const items = getDateReservationItems(date);
  const status = getCalendarStatus(date);
  els.calendarDayReservations.dataset.selectedDate = date;

  if (!items.length) {
    els.calendarDayReservations.innerHTML = `
      <div class="calendar-detail-card">
        <div>
          <span class="eyebrow">SELECTED DATE</span>
          <h4>${formatJPDate(date)}</h4>
          <p>${status.label} · 利用できる枠が残っています。</p>
        </div>
        <span class="status-badge free">空きあり</span>
      </div>`;
    return;
  }

  const rows = items.map(item => `
    <div class="calendar-detail-row">
      <span class="pill">${escapeHTML(item.court)}面</span>
      <div class="calendar-detail-main">
        <strong>${escapeHTML(item.startTime)}〜${escapeHTML(item.endTime)}</strong>
        <span>部活動名：${escapeHTML(item.club || "名称未入力")}</span>
      </div>
      <span class="status-badge reserved">予約済み</span>
    </div>
  `).join("");

  els.calendarDayReservations.innerHTML = `
    <div class="calendar-detail-card">
      <div class="calendar-detail-header">
        <div>
          <span class="eyebrow">SELECTED DATE</span>
          <h4>${formatJPDate(date)}</h4>
        </div>
        <span class="status-badge ${status.type === "full" ? "full" : "partial"}">${escapeHTML(status.label)}</span>
      </div>
      <div class="calendar-detail-list">${rows}</div>
    </div>`;
}

function selectCalendarDate(date) {
  els.calendarDayReservations.dataset.selectedDate = date;
  renderCalendar();
  renderCalendarDayDetail(date);
}

function syncCalendarToMonth() {
  const month = els.adminMonth.value || currentMonth();
  const selected = els.calendarDayReservations.dataset.selectedDate || "";

  if (!selected || selected.slice(0, 7) !== month) {
    renderCalendarDayDetail(null);
  }

  renderCalendar();
}

function flattenMonthReservations(tree) {
  const items = [];
  for (const [date, courts] of Object.entries(tree || {})) {
    for (const [court, slots] of Object.entries(courts || {})) {
      for (const [slotId, reservation] of Object.entries(slots || {})) {
        if (!reservation) continue;
        items.push({ ...reservation, date, court, slotId });
      }
    }
  }
  return items.sort((a,b) =>
    `${a.date} ${a.startTime} ${a.court}`.localeCompare(`${b.date} ${b.startTime} ${b.court}`)
  );
}

function renderReservations() {
  const items = flattenMonthReservations(state.reservations);
  els.monthReservationCount.textContent = items.length;
  els.aCount.textContent = items.filter(x => x.court === "A").length;
  els.bCount.textContent = items.filter(x => x.court === "B").length;
  els.todayCount.textContent = items.filter(x => x.date === todayISO()).length;

  if (!items.length) {
    els.reservationList.innerHTML = `<div class="empty-state">この月の予約はまだありません。</div>`;
    syncCalendarToMonth();
    return;
  }

  els.reservationList.innerHTML = items.map(item => `
    <article class="reservation-item">
      <div>
        <div class="main">${formatJPDate(item.date)}</div>
        <div class="sub">${escapeHTML(item.startTime)}〜${escapeHTML(item.endTime)}</div>
      </div>
      <div>
        <span class="pill">${escapeHTML(item.court)}面</span>
        <div class="club-label">部活動名</div>
        <div class="club-name">${escapeHTML(item.club || "名称未入力")}</div>
      </div>
      <div>
        <div class="main">${escapeHTML(item.startTime)}〜${escapeHTML(item.endTime)}</div>
        <div class="sub">1枠1件まで · 予約済み</div>
      </div>
      <div class="action">
        <button class="cancel-button" type="button"
          data-date="${escapeHTML(item.date)}"
          data-court="${escapeHTML(item.court)}"
          data-slot="${escapeHTML(item.slotId)}">予約を取り消す</button>
      </div>
    </article>
  `).join("");

  els.reservationList.querySelectorAll(".cancel-button").forEach(button => {
    button.addEventListener("click", () => cancelReservation(button.dataset));
  });

  syncCalendarToMonth();
}

function renderRules() {
  const rules = Array.isArray(state.settings.rules) ? [...state.settings.rules] : [];
  rules.sort((a,b) =>
    `${a.startMonth}${a.startTime}`.localeCompare(`${b.startMonth}${b.startTime}`)
  );

  if (!rules.length) {
    els.ruleList.innerHTML = `<div class="empty-state">時間枠ルールがありません。</div>`;
    return;
  }

  els.ruleList.innerHTML = rules.map(rule => `
    <div class="rule-item">
      <div>
        <div class="title">${escapeHTML(rule.startTime)}〜${escapeHTML(rule.endTime)}</div>
        <div class="sub">${escapeHTML(rule.startMonth)} 〜 ${escapeHTML(rule.endMonth)} の間だけ表示</div>
      </div>
      <button class="cancel-button" type="button" data-rule-id="${escapeHTML(rule.id)}">削除</button>
    </div>
  `).join("");

  els.ruleList.querySelectorAll("[data-rule-id]").forEach(button => {
    button.addEventListener("click", () => deleteRule(button.dataset.ruleId));
  });
}

async function saveSettings() {
  state.settings.version = 1;
  cacheSettings(state.settings);

  if (!IS_CONFIGURED) return true;

  try {
    await set(ref(db, "settings"), state.settings);
    return true;
  } catch (error) {
    console.error(error);
    showToast("設定の保存に失敗しました。");
    return false;
  }
}

async function deleteRule(id) {
  if (!confirm("この時間枠ルールを削除しますか？")) return;

  state.settings.rules = (state.settings.rules || []).filter(rule => rule.id !== id);
  const ok = await saveSettings();

  if (ok) {
    renderRules();
    syncCalendarToMonth();
    showToast("時間枠ルールを削除しました");
  }
}

els.ruleForm.addEventListener("submit", async e => {
  e.preventDefault();
  setError(els.ruleError, "");

  const startMonth = els.ruleStartMonth.value;
  const endMonth = els.ruleEndMonth.value;
  const startTime = els.ruleStartTime.value;
  const endTime = els.ruleEndTime.value;

  if (!startMonth || !endMonth || !startTime || !endTime) {
    setError(els.ruleError, "開始月・終了月・開始時刻・終了時刻をすべて入力してください。");
    return;
  }

  if (startMonth > endMonth) {
    setError(els.ruleError, "終了月は開始月以降にしてください。");
    return;
  }

  if (startTime >= endTime) {
    setError(els.ruleError, "終了時刻は開始時刻より後にしてください。");
    return;
  }

  const duplicate = (state.settings.rules || []).some(r =>
    r.startMonth === startMonth &&
    r.endMonth === endMonth &&
    r.startTime === startTime &&
    r.endTime === endTime
  );

  if (duplicate) {
    setError(els.ruleError, "同じルールはすでに登録されています。");
    return;
  }

  state.settings.rules = [
    ...(state.settings.rules || []),
    {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      startMonth,
      endMonth,
      startTime,
      endTime
    }
  ];

  const ok = await saveSettings();

  if (ok) {
    e.target.reset();
    els.ruleStartMonth.value = currentMonth();
    els.ruleEndMonth.value = currentMonth();
    els.ruleStartTime.value = "10:00";
    els.ruleEndTime.value = "13:00";
    renderRules();
    syncCalendarToMonth();
    showToast("時間枠ルールを追加しました");
  }
});

els.saveSiteButton.addEventListener("click", async () => {
  const name = els.schoolNameInput.value.trim();

  if (!name || name.length > 50) {
    els.siteMessage.textContent = "学校・施設名を1〜50文字で入力してください。";
    els.siteMessage.style.color = "#fda4af";
    return;
  }

  state.settings.schoolName = name;
  const ok = await saveSettings();

  if (ok) {
    els.siteMessage.textContent = "設定を保存しました。予約画面にも反映されます。";
    els.siteMessage.style.color = "#7dd3fc";
  }
});

async function cancelReservation({date, court, slot}) {
  if (!IS_CONFIGURED) {
    showToast("デモモードでは別端末共有用の削除処理は使えません。");
    return;
  }

  if (!confirm(`${formatJPDate(date)} ${court}面 ${slot} の予約を取り消しますか？`)) return;

  try {
    await remove(ref(db, `reservations/${date}/${court}/${slot}`));
    showToast("予約を取り消しました");
  } catch (error) {
    console.error(error);
    showToast("予約の取り消しに失敗しました。");
  }
}

function connectDashboard() {
  if (!IS_CONFIGURED) return;

  if (state.unsubMonth) state.unsubMonth();

  const month = els.adminMonth.value || currentMonth();

  state.unsubMonth = onValue(
    ref(db, `reservations/${month}`),
    snap => {
      state.reservations = { [month]: snap.val() || {} };
      renderReservations();
      els.connectionState.innerHTML =
        `<span class="live-dot"></span>リアルタイム接続中 · ${escapeHTML(month)}`;
    },
    error => {
      console.error(error);
      els.connectionState.textContent = "リアルタイム接続エラー";
      showToast("予約一覧を更新できませんでした。");
    }
  );
}

function connectSettings() {
  if (!IS_CONFIGURED) return;

  if (state.unsubSettings) state.unsubSettings();

  state.unsubSettings = onValue(ref(db, "settings"), snap => {
    if (!snap.exists()) return;

    state.settings = {
      ...DEFAULT_SETTINGS,
      ...snap.val(),
      rules: Array.isArray(snap.val().rules) ? snap.val().rules : []
    };

    cacheSettings(state.settings);
    els.schoolNameInput.value = state.settings.schoolName || "";
    renderRules();
    syncCalendarToMonth();
  }, error => {
    console.error(error);
    showToast("設定を読み込めませんでした。");
  });
}

async function demoBoot() {
  const month = els.adminMonth.value || currentMonth();
  const all = {};

  for (let d = 1; d <= 31; d++) {
    const date = `${month}-${String(d).padStart(2,"0")}`;

    try {
      const local = JSON.parse(localStorage.getItem(`gymReservations:${date}`));

      if (local && Object.keys(local).length) {
        all[date] = { A:{}, B:{} };

        for (const [id, reservation] of Object.entries(local)) {
          const court = reservation.court === "B" ? "B" : "A";
          all[date][court][id] = reservation;
        }
      }
    } catch {}
  }

  state.reservations = { [month]: all };
  renderReservations();
  syncCalendarToMonth();
}

function startAdmin() {
  els.adminApp.classList.remove("hidden");
  els.schoolNameInput.value = state.settings.schoolName || "";
  renderRules();

  if (!IS_CONFIGURED) {
    els.connectionState.innerHTML = `<span class="live-dot"></span>デモモード`;
    await demoBoot();
    return;
  }

  els.connectionState.innerHTML = `<span class="live-dot"></span>Firebase接続中…`;

  try {
    // 管理画面も匿名認証するので、Rulesで auth != null を使えます。
    await withTimeout(signInAnonymously(auth), 7000, "匿名認証がタイムアウトしました。");
    els.connectionState.innerHTML = `<span class="live-dot"></span>リアルタイム接続中`;
    connectDashboard();
    connectSettings();
  } catch (error) {
    console.error(error);
    els.connectionState.innerHTML =
      `<span class="live-dot"></span>Firebaseに接続できません`;
    els.reservationList.innerHTML = `
      <div class="empty-state">
        Firebaseへの接続に失敗しました。<br>
        firebase-config.js・Realtime Database・匿名認証・Database Rulesを確認してください。
      </div>`;
    showToast("Firebase接続エラー");
  }
}

els.adminMonth.addEventListener("change", () => {
  if (IS_CONFIGURED) connectDashboard();
  else demoBoot();
  syncCalendarToMonth();
});

els.prevMonthButton.addEventListener("click", () => {
  els.adminMonth.value = addMonths(els.adminMonth.value || currentMonth(), -1);
  if (IS_CONFIGURED) connectDashboard();
  else demoBoot();
  syncCalendarToMonth();
});

els.nextMonthButton.addEventListener("click", () => {
  els.adminMonth.value = addMonths(els.adminMonth.value || currentMonth(), 1);
  if (IS_CONFIGURED) connectDashboard();
  else demoBoot();
  syncCalendarToMonth();
});

startAdmin();

