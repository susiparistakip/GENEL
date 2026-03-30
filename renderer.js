const DEVICE_TYPES = [
  "PC",
  "Yazıcı",
  "Kamera",
  "PDKS",
  "AP",
  "Sunucu",
  "Telefon",
  "NVR",
  "Boş",
];
const FILTER_TYPES = ["Tümü", ...DEVICE_TYPES];
const ICONS = {
  PC: "🖥",
  Yazıcı: "🖨",
  Kamera: "📷",
  PDKS: "⏱",
  AP: "📶",
  Sunucu: "🗄",
  Telefon: "☎",
  NVR: "🎥",
  Boş: "🔌",
  UNINSTALLED: "▫",
};
const CABLES = {
  PC: "#34d399",
  Yazıcı: "#38bdf8",
  Kamera: "#fb7185",
  PDKS: "#fbbf24",
  AP: "#c084fc",
  Sunucu: "#22d3ee",
  Telefon: "#60a5fa",
  NVR: "#fb923c",
  Boş: "#64748b",
  UNINSTALLED: "#64748b",
};

let state = null;
let selectedType = "Tümü";
let selectedId = null;
let dragSourceId = null;
let pendingDropTargetId = null;
let performanceMode = false;
let lastSavedAt = null;
let saveState = "saved";
let cablesQueued = false;
let contextMenuPortId = null;
let dragAutoScrollRaf = null;
let currentDropTargetId = null;
let longPressTimer = null;
let longPressTriggered = false;
const LONG_PRESS_MS = 520;
let dragPreviewPoint = null;
let dragPreviewState = "idle";
let topologyZoom = 1;
let topologyBaseWidth = 0;
let topologyBaseHeight = 0;

const TOPOLOGY_ZOOM_MIN = 0.1;
const TOPOLOGY_ZOOM_MAX = 1.4;
const TOPOLOGY_ZOOM_STEP = 0.1;

const storageAPI = {
  async loadData() {
    try {
      const raw = localStorage.getItem("network-panel-data");
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error(err);
      return null;
    }
  },
  async saveData(data) {
    localStorage.setItem("network-panel-data", JSON.stringify(data));
    return { ok: true };
  },
  async exportData(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "network-panel-data.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  },
  async importData() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve({ ok: false });
        try {
          const text = await file.text();
          resolve({ ok: true, data: JSON.parse(text) });
        } catch (err) {
          await showAppAlert({
            heading: "İçe aktarma hatası",
            subheading: "JSON dosyası okunamadı",
            title: "Dosya açılamadı",
            message: "Seçtiğin JSON dosyası okunamadı.",
            desc: "Dosya bozuk olabilir ya da geçerli JSON formatında olmayabilir.",
            type: "danger",
            okText: "Tamam",
          });
          resolve({ ok: false, error: String(err) });
        }
      };
      input.click();
    });
  },
};

const api = window.networkAPI || storageAPI;
function getTopologyRefs() {
  return {
    stage: document.getElementById("topologyStage"),
    zoomShell: document.getElementById("topologyZoomShell"),
    zoomLayer: document.getElementById("topologyZoomLayer"),
    zoomLabel: document.getElementById("topologyZoomLabel"),
    container: document.getElementById("rackBuilderContainer"),
    svg: document.getElementById("cableSvg"),
  };
}

function clampTopologyZoom(value) {
  return Math.min(TOPOLOGY_ZOOM_MAX, Math.max(TOPOLOGY_ZOOM_MIN, value));
}

function updateTopologyZoomLabel() {
  const { zoomLabel } = getTopologyRefs();
  if (!zoomLabel) return;
  zoomLabel.textContent = `${Math.round(topologyZoom * 100)}%`;
}

function measureTopologyBaseSize() {
  const { stage, zoomLayer, container } = getTopologyRefs();
  if (!stage || !zoomLayer || !container) return;

  topologyBaseWidth = Math.max(
    zoomLayer.scrollWidth,
    container.scrollWidth,
    stage.clientWidth,
    1,
  );

  topologyBaseHeight = Math.max(
    zoomLayer.scrollHeight,
    container.scrollHeight,
    1,
  );
}

function updateTopologyZoomLayout(
  preserveCenter = true,
  previousZoom = topologyZoom,
) {
  const { stage, zoomShell, zoomLayer } = getTopologyRefs();
  if (!stage || !zoomShell || !zoomLayer) return;

  const centerContentX =
    (stage.scrollLeft + stage.clientWidth / 2) / previousZoom;
  const centerContentY =
    (stage.scrollTop + stage.clientHeight / 2) / previousZoom;

  measureTopologyBaseSize();

  zoomLayer.style.width = `${topologyBaseWidth}px`;
  zoomLayer.style.height = `${topologyBaseHeight}px`;
  zoomLayer.style.transform = `scale(${topologyZoom})`;

  const scaledWidth = topologyBaseWidth * topologyZoom;
  const scaledHeight = topologyBaseHeight * topologyZoom;

  zoomShell.style.width = `${scaledWidth}px`;
  zoomShell.style.height = `${scaledHeight}px`;

  updateTopologyZoomLabel();

  requestAnimationFrame(() => {
    if (preserveCenter) {
      stage.scrollLeft = Math.max(
        0,
        centerContentX * topologyZoom - stage.clientWidth / 2,
      );
      stage.scrollTop = Math.max(
        0,
        centerContentY * topologyZoom - stage.clientHeight / 2,
      );
    }

    queueRenderCables();
  });
}

function setTopologyZoom(nextZoom, preserveCenter = true) {
  if (!isTouchZoomLayout()) return;

  const { stage } = getTopologyRefs();

  const clamped = clampTopologyZoom(nextZoom);
  if (Math.abs(clamped - topologyZoom) < 0.001) return;

  const previousZoom = topologyZoom;
  const previousScrollLeft = stage ? stage.scrollLeft : 0;

  topologyZoom = clamped;
  updateTopologyZoomLayout(preserveCenter, previousZoom);

  if (!preserveCenter && stage) {
    requestAnimationFrame(() => {
      stage.scrollLeft = previousScrollLeft;
      stage.scrollTop = 0;
    });
  }
}

function fitTopologyToScreen() {
  if (!isTouchZoomLayout()) {
    syncTopologyInteractionMode();
    return;
  }

  const { stage } = getTopologyRefs();
  if (!stage) return;

  measureTopologyBaseSize();

  const usableWidth = Math.max(stage.clientWidth - 12, 1);
  const usableHeight = Math.max(stage.clientHeight - 12, 1);

  const fitByWidth = usableWidth / Math.max(topologyBaseWidth, 1);
  const mobileMinZoom = 0.95;

  const fitZoom = clampTopologyZoom(Math.max(mobileMinZoom, fitByWidth));
  topologyZoom = fitZoom;
  updateTopologyZoomLayout(false);

  requestAnimationFrame(() => {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  });
}
function refreshTopologyLayoutNow() {
  syncTopologyInteractionMode();
  fitTopologyToScreen();
  updateTopologyZoomLayout(false);
  queueRenderCables();
}

function getAppAlertRefs() {
  return {
    modal: document.getElementById("appAlertModal"),
    card: document.querySelector("#appAlertModal .app-alert-card"),
    heading: document.getElementById("appAlertHeading"),
    subheading: document.getElementById("appAlertSubheading"),
    icon: document.getElementById("appAlertIcon"),
    title: document.getElementById("appAlertTitle"),
    message: document.getElementById("appAlertMessage"),
    desc: document.getElementById("appAlertDesc"),
    okBtn: document.getElementById("appAlertOk"),
    cancelBtn: document.getElementById("appAlertCancel"),
    closeBtn: document.getElementById("appAlertClose"),
    actions: document.getElementById("appAlertActions"),
  };
}

function cleanupAppAlertCardClasses(card) {
  if (!card) return;
  card.classList.remove("is-info", "is-success", "is-warning", "is-danger");
}

function showAppAlert({
  heading = "Bilgi",
  subheading = "İşlem bildirimi",
  title = "Mesaj",
  message = "",
  desc = "",
  type = "info",
  okText = "Tamam",
} = {}) {
  const refs = getAppAlertRefs();
  if (!refs.modal) {
    alert(message || title);
    return Promise.resolve(true);
  }

  const {
    modal,
    card,
    heading: headingEl,
    subheading: subheadingEl,
    icon,
    title: titleEl,
    message: messageEl,
    desc: descEl,
    okBtn,
    cancelBtn,
    closeBtn,
    actions,
  } = refs;

  cleanupAppAlertCardClasses(card);

  const iconMap = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    danger: "⛔",
  };

  card.classList.add(
    type === "success"
      ? "is-success"
      : type === "warning"
        ? "is-warning"
        : type === "danger"
          ? "is-danger"
          : "is-info",
  );

  headingEl.textContent = heading;
  subheadingEl.textContent = subheading;
  titleEl.textContent = title;
  messageEl.textContent = message;
  icon.textContent = iconMap[type] || "ℹ️";
  okBtn.textContent = okText;

  if (desc && String(desc).trim()) {
    descEl.textContent = desc;
    descEl.classList.remove("hidden");
  } else {
    descEl.textContent = "";
    descEl.classList.add("hidden");
  }

  cancelBtn.classList.add("hidden");
  actions.classList.remove("two-buttons");
  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;

      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      closeBtn.removeEventListener("click", handleOk);
      modal.removeEventListener("click", handleOverlay);
      document.removeEventListener("keydown", handleKeydown);

      resolve(true);
    };

    const handleOk = () => finish();
    const handleOverlay = (e) => {
      if (e.target === modal) finish();
    };
    const handleKeydown = (e) => {
      if (e.key === "Escape") finish();
    };

    okBtn.addEventListener("click", handleOk);
    closeBtn.addEventListener("click", handleOk);
    modal.addEventListener("click", handleOverlay);
    document.addEventListener("keydown", handleKeydown);
  });
}

function showAppConfirm({
  heading = "Onay",
  subheading = "Bu işlem için onay gerekiyor",
  title = "Devam edilsin mi?",
  message = "",
  desc = "",
  type = "warning",
  okText = "Tamam",
  cancelText = "İptal",
} = {}) {
  const refs = getAppAlertRefs();
  if (!refs.modal) {
    return Promise.resolve(confirm(message || title));
  }

  const {
    modal,
    card,
    heading: headingEl,
    subheading: subheadingEl,
    icon,
    title: titleEl,
    message: messageEl,
    desc: descEl,
    okBtn,
    cancelBtn,
    closeBtn,
  } = refs;

  cleanupAppAlertCardClasses(card);

  const iconMap = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    danger: "⛔",
  };

  card.classList.add(
    type === "success"
      ? "is-success"
      : type === "warning"
        ? "is-warning"
        : type === "danger"
          ? "is-danger"
          : "is-info",
  );

  headingEl.textContent = heading;
  subheadingEl.textContent = subheading;
  titleEl.textContent = title;
  messageEl.textContent = message;
  icon.textContent = iconMap[type] || "⚠️";
  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;
  cancelBtn.classList.remove("hidden");

  if (desc && String(desc).trim()) {
    descEl.textContent = desc;
    descEl.classList.remove("hidden");
  } else {
    descEl.textContent = "";
    descEl.classList.add("hidden");
  }

  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;

      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      cancelBtn.removeEventListener("click", handleCancel);
      closeBtn.removeEventListener("click", handleCancel);
      modal.removeEventListener("click", handleOverlay);
      document.removeEventListener("keydown", handleKeydown);

      resolve(result);
    };

    const handleOk = () => finish(true);
    const handleCancel = () => finish(false);
    const handleOverlay = (e) => {
      if (e.target === modal) finish(false);
    };
    const handleKeydown = (e) => {
      if (e.key === "Escape") finish(false);
    };

    okBtn.addEventListener("click", handleOk);
    cancelBtn.addEventListener("click", handleCancel);
    closeBtn.addEventListener("click", handleCancel);
    modal.addEventListener("click", handleOverlay);
    document.addEventListener("keydown", handleKeydown);
  });
}

function ensureAppDialog() {
  if (document.getElementById("appDialogModal")) return;

  const modal = document.createElement("div");
  modal.id = "appDialogModal";
  modal.className = "modal-overlay hidden";
  modal.innerHTML = `
    <div class="modal-card app-dialog-card app-dialog-alert" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle" aria-describedby="appDialogMessage">
      <div class="modal-head app-dialog-head">
        <div>
          <h3 id="appDialogTitle">Bilgilendirme</h3>
          <p id="appDialogSubtitle">İşlem sonucu</p>
        </div>
        <button type="button" class="icon-btn" id="appDialogClose">✕</button>
      </div>

      <div class="disconnect-confirm-body app-dialog-body">
        <div class="disconnect-confirm-icon app-dialog-icon" id="appDialogIcon">ℹ️</div>
        <div class="disconnect-confirm-text app-dialog-text">
          <strong id="appDialogMessage">Mesaj</strong>
          <p id="appDialogDetail" class="app-dialog-detail hidden"></p>
        </div>
      </div>

      <div class="modal-actions app-dialog-actions">
        <button type="button" class="btn" id="appDialogCancel">Vazgeç</button>
        <button type="button" class="btn primary" id="appDialogOk">Tamam</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function showAppDialog(options = {}) {
  ensureAppDialog();

  const {
    variant = "info",
    title = variant === "confirm" ? "Onay gerekli" : "Bilgilendirme",
    subtitle = variant === "confirm"
      ? "Devam etmek için seçimini yap."
      : "İşlem sonucu",
    message = "",
    detail = "",
    okText = "Tamam",
    cancelText = "Vazgeç",
    showCancel = variant === "confirm",
    closeOnOverlay = !showCancel,
    closeOnEscape = true,
  } = options;

  const modal = document.getElementById("appDialogModal");
  const card = modal?.querySelector(".app-dialog-card");
  const titleEl = document.getElementById("appDialogTitle");
  const subtitleEl = document.getElementById("appDialogSubtitle");
  const iconEl = document.getElementById("appDialogIcon");
  const messageEl = document.getElementById("appDialogMessage");
  const detailEl = document.getElementById("appDialogDetail");
  const okBtn = document.getElementById("appDialogOk");
  const cancelBtn = document.getElementById("appDialogCancel");
  const closeBtn = document.getElementById("appDialogClose");

  if (
    !modal ||
    !card ||
    !titleEl ||
    !subtitleEl ||
    !iconEl ||
    !messageEl ||
    !detailEl ||
    !okBtn ||
    !cancelBtn ||
    !closeBtn
  ) {
    return Promise.resolve(false);
  }

  card.classList.remove(
    "app-dialog-alert",
    "app-dialog-confirm",
    "app-dialog-success",
    "app-dialog-warning",
    "app-dialog-error",
  );

  const iconMap = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "⛔",
    confirm: "❓",
  };

  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  iconEl.textContent = iconMap[variant] || iconMap.info;
  messageEl.textContent = message;
  detailEl.textContent = detail || "";
  detailEl.classList.toggle("hidden", !detail);
  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;
  cancelBtn.classList.toggle("hidden", !showCancel);
  closeBtn.classList.toggle("hidden", showCancel);
  card.classList.add(`app-dialog-${variant === "info" ? "alert" : variant}`);
  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      cancelBtn.removeEventListener("click", handleCancel);
      closeBtn.removeEventListener("click", handleClose);
      modal.removeEventListener("click", handleOverlay);
      document.removeEventListener("keydown", handleKeydown);
      resolve(result);
    };

    const handleOk = () => finish(true);
    const handleCancel = () => finish(false);
    const handleClose = () => finish(showCancel ? false : true);
    const handleOverlay = (e) => {
      if (e.target === modal && closeOnOverlay)
        finish(showCancel ? false : true);
    };
    const handleKeydown = (e) => {
      if (e.key === "Escape" && closeOnEscape)
        finish(showCancel ? false : true);
    };

    okBtn.addEventListener("click", handleOk);
    cancelBtn.addEventListener("click", handleCancel);
    closeBtn.addEventListener("click", handleClose);
    modal.addEventListener("click", handleOverlay);
    document.addEventListener("keydown", handleKeydown);
  });
}

function showAppAlert(message, options = {}) {
  return showAppDialog({
    variant: options.variant || "info",
    title: options.title || "Bilgilendirme",
    subtitle: options.subtitle || "İşlem sonucu",
    message,
    detail: options.detail || "",
    okText: options.okText || "Tamam",
    showCancel: false,
  });
}

function showAppConfirm(message, options = {}) {
  return showAppDialog({
    variant: options.variant || "confirm",
    title: options.title || "Onay gerekli",
    subtitle: options.subtitle || "Devam etmek için seçimini yap.",
    message,
    detail: options.detail || "",
    okText: options.okText || "Tamam",
    cancelText: options.cancelText || "Vazgeç",
    showCancel: true,
    closeOnOverlay: false,
  });
}

function loadPerformanceMode() {
  try {
    return localStorage.getItem("network-panel-performance") === "1";
  } catch (err) {
    return false;
  }
}

function savePerformanceMode(value) {
  try {
    localStorage.setItem("network-panel-performance", value ? "1" : "0");
  } catch (err) {
    console.error(err);
  }
}

function updatePerformanceUI() {
  document.body.classList.toggle("performance-mode", performanceMode);
  const btn = document.getElementById("btnPerformanceMode");
  if (btn)
    btn.textContent = `Performans Modu: ${performanceMode ? "Açık" : "Kapalı"}`;
}

function formatSaveTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function updateSaveStatusUI() {
  const badge = document.getElementById("saveStatus");
  const btn = document.getElementById("btnSaveNow");
  if (!badge) return;

  badge.classList.remove("saving", "saved", "error");

  if (saveState === "saving") {
    badge.textContent = "Kaydediliyor...";
    badge.classList.add("saving");
    if (btn) btn.disabled = true;
    return;
  }

  if (saveState === "error") {
    badge.textContent = "Kaydetme hatası";
    badge.classList.add("error");
    if (btn) btn.disabled = false;
    return;
  }

  badge.textContent = lastSavedAt
    ? `Kaydedildi • ${formatSaveTime(lastSavedAt)}`
    : "Kaydedildi";
  badge.classList.add("saved");
  if (btn) btn.disabled = false;
}

function markSaveState(nextState) {
  saveState = nextState;
  updateSaveStatusUI();
}

function normalizeImportedState(rawState) {
  const safeState =
    rawState && typeof rawState === "object" ? rawState : createInitialState();

  if (!Array.isArray(safeState.rackDevices)) {
    safeState.rackDevices = [];
  }

  const incomingFloorPlans =
    safeState.floorPlans && typeof safeState.floorPlans === "object"
      ? safeState.floorPlans
      : {};

  safeState.floorPlans = Object.fromEntries(
    Object.entries(incomingFloorPlans)
      .filter(([key]) => typeof key === "string")
      .map(([key, value]) => [key, typeof value === "string" ? value : ""]),
  );

  safeState.rackDevices = safeState.rackDevices
    .filter((device) => device && typeof device === "object")
    .map((device, deviceIndex) => {
      const kind = device.kind === "patch" ? "patch" : "switch";
      const portCount = Math.max(1, Number(device.portCount) || 24);
      const fallbackId = `${kind}-${Date.now()}-${deviceIndex + 1}`;
      const safeDevice = {
        id: device.id || fallbackId,
        title:
          (typeof device.title === "string" && device.title.trim()) ||
          (kind === "patch"
            ? `PATCH PANEL ${deviceIndex + 1}`
            : `SWITCH ${deviceIndex + 1}`),
        kind,
        portCount,
        codePrefix:
          (typeof device.codePrefix === "string" && device.codePrefix.trim()) ||
          (kind === "patch" ? `P${deviceIndex + 1}` : `SW${deviceIndex + 1}`),
        colorClass:
          (typeof device.colorClass === "string" && device.colorClass.trim()) ||
          (kind === "patch" ? "pink" : "cyan"),
        ports: [],
      };

      const fallbackPorts = createPortsForDevice({
        id: safeDevice.id,
        kind: safeDevice.kind,
        portCount: safeDevice.portCount,
        codePrefix: safeDevice.codePrefix,
      });

      const incomingPorts = Array.isArray(device.ports) ? device.ports : [];

      safeDevice.ports = fallbackPorts.map((fallbackPort, portIndex) => {
        const incoming = incomingPorts[portIndex] || {};
        const basePort = {
          ...fallbackPort,
          ...incoming,
          id:
            typeof incoming.id === "string" && incoming.id.trim()
              ? incoming.id
              : fallbackPort.id,
          layer: safeDevice.id,
          rackDeviceId: safeDevice.id,
          fixed: false,
          type:
            typeof incoming.type === "string" && incoming.type.trim()
              ? incoming.type
              : "Boş",
          name: typeof incoming.name === "string" ? incoming.name : "",
          user: typeof incoming.user === "string" ? incoming.user : "",
          floor: typeof incoming.floor === "string" ? incoming.floor : "",
          room: typeof incoming.room === "string" ? incoming.room : "",
          ip: typeof incoming.ip === "string" ? incoming.ip : "",
          note: typeof incoming.note === "string" ? incoming.note : "",
          active: Boolean(incoming.active),
        };

        if (safeDevice.kind === "patch") {
          basePort.installed = Boolean(incoming.installed);
          basePort.connectedTo =
            typeof incoming.connectedTo === "string" &&
            incoming.connectedTo.trim()
              ? incoming.connectedTo
              : null;
          delete basePort.connectedFrom;
        } else {
          basePort.connectedFrom =
            typeof incoming.connectedFrom === "string" &&
            incoming.connectedFrom.trim()
              ? incoming.connectedFrom
              : null;
          delete basePort.installed;
          delete basePort.connectedTo;
        }

        return basePort;
      });

      return safeDevice;
    });

  return safeState;
}

function queueRenderCables() {
  if (cablesQueued) return;
  cablesQueued = true;
  requestAnimationFrame(() => {
    cablesQueued = false;
    renderCables();
  });
}

function createPortsForDevice(device) {
  const prefix = device.codePrefix;
  const count = Number(device.portCount) || 0;

  if (device.kind === "patch") {
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i + 1}`,
      layer: device.id,
      rackDeviceId: device.id,
      fixed: false,
      installed: false,
      active: false,
      type: "Boş",
      name: "",
      user: "",
      floor: "",
      room: "",
      ip: "",
      note: "",
      connectedTo: null,
    }));
  }

  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    layer: device.id,
    rackDeviceId: device.id,
    fixed: false,
    active: false,
    type: "Boş",
    name: "",
    user: "",
    floor: "",
    room: "",
    ip: "",
    note: "",
    connectedFrom: null,
  }));
}

function createRackDevice({
  id,
  title,
  kind,
  portCount,
  codePrefix,
  colorClass = "cyan",
}) {
  return {
    id,
    title,
    kind,
    portCount,
    codePrefix,
    colorClass,
    ports: createPortsForDevice({
      id,
      kind,
      portCount,
      codePrefix,
    }),
  };
}

function createInitialState() {
  return {
    rackDevices: [],
    floorPlans: {},
  };
}

function allItems() {
  return state.rackDevices.flatMap((device) => device.ports);
}

function byId(id) {
  return allItems().find((x) => x.id === id);
}

function getRackDeviceById(deviceId) {
  return state.rackDevices.find((x) => x.id === deviceId);
}

function getRackDeviceFromPort(item) {
  if (!item) return null;
  return getRackDeviceById(item.rackDeviceId);
}

function isPatch(item) {
  const device = getRackDeviceFromPort(item);
  return device?.kind === "patch";
}

function isSwitch(item) {
  const device = getRackDeviceFromPort(item);
  return device?.kind === "switch";
}

function getGridClassByPortCount(portCount) {
  const count = Number(portCount) || 0;
  if (count <= 8) return "cols-4";
  if (count <= 16) return "cols-8";
  if (count <= 24) return "cols-8";
  return "cols-12";
}

function addRackDevice({ kind, title, portCount, codePrefix, colorClass }) {
  const sameKindCount =
    state.rackDevices.filter((x) => x.kind === kind).length + 1;

  const device = createRackDevice({
    id: `${kind}-${Date.now()}-${sameKindCount}`,
    title:
      title?.trim() ||
      (kind === "patch"
        ? `PATCH PANEL ${sameKindCount}`
        : `SWITCH ${sameKindCount}`),
    kind,
    portCount: Number(portCount),
    codePrefix:
      codePrefix?.trim() ||
      (kind === "patch" ? `P${sameKindCount}` : `SW${sameKindCount}`),
    colorClass: colorClass || (kind === "patch" ? "pink" : "cyan"),
  });

  state.rackDevices.push(device);
  renderAll();
}

function removeRackDevice(deviceId) {
  const device = getRackDeviceById(deviceId);
  if (!device) return;

  for (const port of device.ports) {
    if (isPatch(port) && port.connectedTo) {
      const target = byId(port.connectedTo);
      if (target) {
        target.connectedFrom = null;
        target.active = false;
        target.type = "Boş";
        target.name = "";
        target.user = "";
        target.floor = "";
        target.room = "";
        target.ip = "";
        target.note = "";
      }
    }

    if (isSwitch(port) && port.connectedFrom) {
      const patch = byId(port.connectedFrom);
      if (patch) {
        patch.connectedTo = null;
      }
    }
  }

  state.rackDevices = state.rackDevices.filter((x) => x.id !== deviceId);
  selectedId = null;
  clearHighlight();
  renderAll();
}

function highlightConnection(portId) {
  const item = byId(portId);
  if (!item) return;

  let patchId = null;
  let switchId = null;

  if (isPatch(item)) {
    if (!item.connectedTo) return;
    patchId = item.id;
    switchId = item.connectedTo;
  } else if (isSwitch(item)) {
    if (!item.connectedFrom) return;
    patchId = item.connectedFrom;
    switchId = item.id;
  } else {
    return;
  }

  const patchEl = document.querySelector(`[data-port="${patchId}"]`);
  const switchEl = document.querySelector(`[data-port="${switchId}"]`);
  const cable = document.querySelector(`[data-cable="${patchId}-${switchId}"]`);

  document.querySelectorAll("[data-port]").forEach((el) => {
    el.classList.add("dimmed");
  });

  document.querySelectorAll("[data-cable]").forEach((el) => {
    el.classList.add("dimmed");
  });

  patchEl?.classList.remove("dimmed");
  switchEl?.classList.remove("dimmed");
  cable?.classList.remove("dimmed");

  patchEl?.classList.add("link-highlight");
  switchEl?.classList.add("link-highlight");
  cable?.classList.add("cable-highlight");
}

function previewConnection(portId) {
  if (selectedId) return;
  clearHighlight();
  highlightConnection(portId);
}

function clearPreview() {
  if (selectedId) {
    clearHighlight();
    highlightConnection(selectedId);
    return;
  }
  clearHighlight();
}

function clearHighlight() {
  document.querySelectorAll(".dimmed").forEach((el) => {
    el.classList.remove("dimmed");
  });

  document.querySelectorAll(".link-highlight").forEach((el) => {
    el.classList.remove("link-highlight");
  });

  document.querySelectorAll(".cable-highlight").forEach((el) => {
    el.classList.remove("cable-highlight");
  });
}

function clearDeviceDropHighlights() {
  document.querySelectorAll(".device-drop-active").forEach((el) => {
    el.classList.remove("device-drop-active");
  });

  document.querySelectorAll(".device-drop-invalid").forEach((el) => {
    el.classList.remove("device-drop-invalid");
  });
}

function clearDragVisuals() {
  document.querySelectorAll(".drag-source").forEach((el) => {
    el.classList.remove("drag-source");
  });

  document.querySelectorAll(".drop-ready").forEach((el) => {
    el.classList.remove("drop-ready");
  });

  document.querySelectorAll(".drop-occupied").forEach((el) => {
    el.classList.remove("drop-occupied");
  });

  clearDeviceDropHighlights();
  currentDropTargetId = null;
}

function applyDragTargetVisual(targetId) {
  clearDragVisuals();

  if (dragSourceId) {
    const sourceEl = document.querySelector(`[data-port="${dragSourceId}"]`);
    sourceEl?.classList.add("drag-source");
  }

  if (!targetId) return;

  const target = byId(targetId);
  const targetEl = document.querySelector(`[data-port="${targetId}"]`);
  if (!target || !targetEl) return;

  const occupiedByAnotherPatch =
    target.connectedFrom && target.connectedFrom !== dragSourceId;

  targetEl.classList.add(
    occupiedByAnotherPatch ? "drop-occupied" : "drop-ready",
  );

  const targetDevice = getRackDeviceFromPort(targetId);
  if (targetDevice?.id) {
    const deviceEl = document.querySelector(
      `[data-device-id="${targetDevice.id}"]`,
    );
    deviceEl?.classList.add(
      occupiedByAnotherPatch ? "device-drop-invalid" : "device-drop-active",
    );
  }

  currentDropTargetId = targetId;
}

function isMobileConnectionScroll() {
  return window.innerWidth <= 1024;
}

function scrollPortIntoView(portId) {
  if (!portId) return;
  if (!isTouchZoomLayout()) return;

  const el = document.querySelector(`[data-port="${portId}"]`);
  if (!el) return;

  el.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
}

function scrollToConnection(portId) {
  if (!isTouchZoomLayout()) return;

  const item = byId(portId);
  if (!item) return;

  let targetId = null;

  if (isPatch(item)) {
    targetId = item.connectedTo;
  } else if (isSwitch(item)) {
    targetId = item.connectedFrom;
  }

  if (!targetId) return;

  requestAnimationFrame(() => {
    scrollPortIntoView(targetId);
  });
}

function pointFromClient(clientX, clientY) {
  const { zoomLayer } = getTopologyRefs();
  if (!zoomLayer) return null;

  const rect = zoomLayer.getBoundingClientRect();

  return {
    x: (clientX - rect.left) / topologyZoom,
    y: (clientY - rect.top) / topologyZoom,
  };
}

function updateDragPreviewPoint(clientX, clientY) {
  if (!dragSourceId) return;
  if (clientX === 0 && clientY === 0) return;

  const point = pointFromClient(clientX, clientY);
  if (!point) return;

  dragPreviewPoint = point;
  queueRenderCables();
}

function clearDragPreviewPoint() {
  dragPreviewPoint = null;
  dragPreviewState = "idle";
  queueRenderCables();
}
function setDragPreviewState(stateName) {
  dragPreviewState = stateName;
  queueRenderCables();
}

function drawPreviewCable(svg, x1, y1, x2, y2, color) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const dx = Math.abs(x2 - x1);
  const curve = Math.max(36, Math.min(90, dx * 0.28));
  const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;

  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", "2.1");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("opacity", "0.9");
  path.setAttribute("stroke-dasharray", "8 6");
  path.setAttribute("data-cable-preview", "true");
  path.style.pointerEvents = "none";
  path.style.filter = performanceMode
    ? "none"
    : `drop-shadow(0 0 3px ${color})`;

  svg.appendChild(path);
}
function stopDragAutoScroll() {
  if (dragAutoScrollRaf) {
    cancelAnimationFrame(dragAutoScrollRaf);
    dragAutoScrollRaf = null;
  }
}

function startDragAutoScroll(clientX, clientY) {
  const viewportEdge = 90;
  const speed = 22;

  let pageDy = 0;

  const doc = document.documentElement;
  const canPageScrollY = doc.scrollHeight > window.innerHeight;

  if (canPageScrollY) {
    if (clientY < viewportEdge) pageDy = -speed;
    else if (clientY > window.innerHeight - viewportEdge) pageDy = speed;
  }

  stopDragAutoScroll();

  if (!pageDy) return;

  const tick = () => {
    if (pageDy) {
      window.scrollBy(0, pageDy);
    }

    queueRenderCables();
    dragAutoScrollRaf = requestAnimationFrame(tick);
  };

  dragAutoScrollRaf = requestAnimationFrame(tick);
}
function ensurePortContextMenu() {
  if (document.getElementById("portContextMenu")) return;

  const menu = document.createElement("div");
  menu.id = "portContextMenu";
  menu.className = "port-context-menu hidden";
  menu.innerHTML = `
    <button type="button" class="context-menu-item" data-action="highlight">
      Bağlantıyı vurgula
    </button>
    <button type="button" class="context-menu-item" data-action="goto">
      Eş porta git
    </button>
    <button type="button" class="context-menu-item danger" data-action="disconnect">
      Bağlantıyı kaldır
    </button>
  `;

  document.body.appendChild(menu);
}

function closePortContextMenu() {
  const menu = document.getElementById("portContextMenu");
  if (!menu) return;

  menu.classList.add("hidden");
  menu.style.left = "";
  menu.style.top = "";
  contextMenuPortId = null;
}

function getLinkedPortId(portId) {
  const item = byId(portId);
  if (!item) return null;

  if (isPatch(item)) return item.connectedTo || null;
  if (isSwitch(item)) return item.connectedFrom || null;

  return null;
}

function openPortContextMenu(portId, clientX, clientY) {
  ensurePortContextMenu();

  const menu = document.getElementById("portContextMenu");
  if (!menu) return;

  const linkedPortId = getLinkedPortId(portId);
  contextMenuPortId = portId;

  menu.classList.remove("hidden");

  const gotoBtn = menu.querySelector('[data-action="goto"]');
  const disconnectBtn = menu.querySelector('[data-action="disconnect"]');

  if (gotoBtn) gotoBtn.disabled = !linkedPortId;
  if (disconnectBtn) disconnectBtn.disabled = !linkedPortId;

  const margin = 10;
  const menuWidth = 220;
  const menuHeight = 140;

  let left = clientX;
  let top = clientY;

  if (left + menuWidth > window.innerWidth - margin) {
    left = window.innerWidth - menuWidth - margin;
  }

  if (top + menuHeight > window.innerHeight - margin) {
    top = window.innerHeight - menuHeight - margin;
  }

  if (left < margin) left = margin;
  if (top < margin) top = margin;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function attachLongPressMenu(card, item) {
  if (!card || !item) return;

  const cancel = () => {
    clearLongPressTimer();
  };

  card.addEventListener(
    "touchstart",
    (e) => {
      if (!e.touches?.length) return;
      longPressTriggered = false;

      const touch = e.touches[0];
      clearLongPressTimer();

      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        selectedId = item.id;
        renderAll();
        if (navigator.vibrate) navigator.vibrate(18);
        openPortContextMenu(item.id, touch.clientX, touch.clientY);
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  card.addEventListener(
    "touchmove",
    () => {
      cancel();
    },
    { passive: true },
  );

  card.addEventListener("touchend", cancel, { passive: true });
  card.addEventListener("touchcancel", cancel, { passive: true });
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function isTouchZoomLayout() {
  return window.matchMedia("(max-width: 1024px)").matches;
}

function syncTopologyInteractionMode() {
  const { stage, zoomShell, zoomLayer, zoomLabel } = getTopologyRefs();
  const zoomControls = document.getElementById("topologyZoomControls");
  if (!stage || !zoomShell || !zoomLayer) return;

  const isTouchLayout = isTouchZoomLayout();

  document.body.classList.toggle("desktop-topology-mode", !isTouchLayout);
  document.body.classList.toggle("touch-topology-mode", isTouchLayout);

  if (zoomControls) {
    zoomControls.hidden = !isTouchLayout;
  }

  if (!isTouchLayout) {
    topologyZoom = 1;
    updateTopologyZoomLabel();
    measureTopologyBaseSize();

    const availableWidth = Math.max(stage.clientWidth - 8, 1);
    const availableHeight = Math.max(stage.clientHeight - 8, 1);
    const fitByWidth = availableWidth / Math.max(topologyBaseWidth, 1);
    const fitByHeight = availableHeight / Math.max(topologyBaseHeight, 1);
    const desktopZoom = Math.min(1, fitByWidth, fitByHeight);

    topologyZoom = clampTopologyZoom(desktopZoom);

    zoomLayer.style.width = `${topologyBaseWidth}px`;
    zoomLayer.style.height = `${topologyBaseHeight}px`;
    zoomLayer.style.transform = `scale(${topologyZoom})`;

    zoomShell.style.width = `${topologyBaseWidth * topologyZoom}px`;
    zoomShell.style.height = `${topologyBaseHeight * topologyZoom}px`;

    if (zoomLabel) {
      zoomLabel.textContent = "PC";
    }

    requestAnimationFrame(() => {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
      queueRenderCables();
    });
    return;
  }

  updateTopologyZoomLayout(false);
}
function ensureDisconnectConfirmModal() {
  if (document.getElementById("disconnectConfirmModal")) return;

  const modal = document.createElement("div");
  modal.id = "disconnectConfirmModal";
  modal.className = "modal-overlay hidden";
  modal.innerHTML = `
    <div class="modal-card disconnect-confirm-card">
      <div class="modal-head">
        <div>
          <h3>Bağlantıyı kaldır</h3>
          <p>Bu işlem patch ile switch arasındaki bağlantıyı kaldırır.</p>
        </div>
        <button type="button" class="icon-btn" id="disconnectConfirmClose">✕</button>
      </div>

      <div class="disconnect-confirm-body">
        <div class="disconnect-confirm-icon">🔌</div>
        <div class="disconnect-confirm-text">
          <strong id="disconnectConfirmTitle">Bağlantı kaldırılsın mı?</strong>
          <div id="disconnectConfirmPair" class="disconnect-confirm-pair">A-1 ↔ SW1-33</div>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn" id="disconnectConfirmCancel">Vazgeç</button>
        <button type="button" class="btn danger" id="disconnectConfirmOk">Bağlantıyı Kaldır</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function askDisconnectConfirmation(portId, linkedPortId) {
  ensureDisconnectConfirmModal();

  const modal = document.getElementById("disconnectConfirmModal");
  const pair = document.getElementById("disconnectConfirmPair");
  const okBtn = document.getElementById("disconnectConfirmOk");
  const cancelBtn = document.getElementById("disconnectConfirmCancel");
  const closeBtn = document.getElementById("disconnectConfirmClose");

  if (!modal || !pair || !okBtn || !cancelBtn || !closeBtn) {
    return Promise.resolve(false);
  }

  pair.textContent = `${portId} ↔ ${linkedPortId}`;
  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;

      modal.classList.add("hidden");

      okBtn.removeEventListener("click", handleOk);
      cancelBtn.removeEventListener("click", handleCancel);
      closeBtn.removeEventListener("click", handleCancel);
      modal.removeEventListener("click", handleOverlay);
      document.removeEventListener("keydown", handleKeydown);

      resolve(result);
    };

    const handleOk = () => finish(true);
    const handleCancel = () => finish(false);
    const handleOverlay = (e) => {
      if (e.target === modal) finish(false);
    };
    const handleKeydown = (e) => {
      if (e.key === "Escape") finish(false);
    };

    okBtn.addEventListener("click", handleOk);
    cancelBtn.addEventListener("click", handleCancel);
    closeBtn.addEventListener("click", handleCancel);
    modal.addEventListener("click", handleOverlay);
    document.addEventListener("keydown", handleKeydown);
  });
}
async function disconnectPortConnection(portId) {
  const item = byId(portId);
  if (!item) return;

  if (isPatch(item)) {
    if (!item.connectedTo) return;
    clearSwitchBacklink(item.connectedTo);
    item.connectedTo = null;
  } else if (isSwitch(item)) {
    if (!item.connectedFrom) return;
    const patch = byId(item.connectedFrom);
    if (patch) patch.connectedTo = null;
    clearSwitchBacklink(item.id);
  } else {
    return;
  }

  selectedId = null;
  await persist();
  clearHighlight();
  renderAll();
}
function syncConnections() {
  const switches = allItems().filter((x) => isSwitch(x));
  const patches = allItems().filter((x) => isPatch(x));

  for (const sw of switches) {
    sw.connectedFrom = null;
    sw.active = false;
    sw.type = "Boş";
    sw.name = "";
    sw.user = "";
    sw.floor = "";
    sw.room = "";
    sw.ip = "";
    sw.note = "";
  }

  for (const patch of patches) {
    if (!patch.installed) {
      patch.connectedTo = null;
      patch.active = false;
      patch.type = "Boş";
      patch.name = "";
      patch.user = "";
      patch.floor = "";
      patch.room = "";
      patch.ip = "";
      patch.note = "";
      continue;
    }

    if (!patch.connectedTo) continue;

    const target = byId(patch.connectedTo);
    if (!target || !isSwitch(target)) {
      patch.connectedTo = null;
      continue;
    }

    target.connectedFrom = patch.id;
    target.active = patch.active;
    target.type = patch.type;
    target.name = patch.name;
    target.user = patch.user;
    target.floor = patch.floor;
    target.room = patch.room;
    target.ip = patch.ip;
    target.note = patch.note;
  }
}

async function persist() {
  syncConnections();
  markSaveState("saving");

  try {
    await api.saveData(state);
    lastSavedAt = new Date();
    markSaveState("saved");
    return true;
  } catch (err) {
    console.error(err);
    markSaveState("error");
    return false;
  }
}

function renderFilters() {
  const select = document.getElementById("typeFilterSelect");
  if (!select) return;
  const current = select.value || selectedType;
  select.innerHTML = "";
  FILTER_TYPES.forEach((type) => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    if (type === current) opt.selected = true;
    select.appendChild(opt);
  });
  selectedType = current || "Tümü";
}

function displayType(item) {
  if (isPatch(item) && !item.installed) return "UNINSTALLED";
  return item.type || "Boş";
}

function displayName(item) {
  if (isPatch(item) && !item.installed) return "Patch Takılı Değil";
  if (isSwitch(item) && !item.connectedFrom) return "Bağlantı Yok";
  return formatAssignment(item);
}


function formatAssignment(item) {
  const unit = (item.room || "").trim();
  const person = (item.user || "").trim();

  if (unit && person) return `${unit} / ${person}`;
  if (unit) return unit;
  if (person) return person;
  return "Tanımsız";
}

function formatPortLabel(item) {
  return `${item.id} - ${formatAssignment(item)}`;
}

function createPortCard(item) {
  const dType = displayType(item);
  const card = document.createElement("button");
  card.type = "button";
  card.dataset.port = item.id;
  card.className = `port-card compact ${isSwitch(item) ? "switch-card" : "patch-card"} type-${dType} ${selectedId === item.id ? "selected" : ""}`;

  const isPatchCard = isPatch(item);
  const isSwitchCard = isSwitch(item);
  const hasConnection =
    (isPatchCard && !!item.connectedTo) ||
    (isSwitchCard && !!item.connectedFrom);

  if (hasConnection) {
    card.classList.add("has-hover");
  } else {
    card.classList.add("no-connection");
  }

  if (isPatch(item)) {
    const icon = item.installed ? ICONS[dType] || "🔌" : "";
    const patchStatus = item.connectedTo ? `Bağlı: ${item.connectedTo}` : "BOŞTA";
    const patchNote = (item.note || "").trim();
    const patchPreview = item.connectedTo
      ? `
        <div class="patch-hover-preview">
          <div class="patch-hover-title">${item.id}</div>
          <div class="patch-hover-line">
            <span class="patch-hover-label">Birim</span>
            ${(item.room || "-").trim() || "-"}
          </div>
          <div class="patch-hover-line">
            <span class="patch-hover-label">Kullanıcı</span>
            ${(item.user || "-").trim() || "-"}
          </div>
          ${patchNote ? `
          <div class="patch-hover-line">
            <span class="patch-hover-label">Not</span>
            ${patchNote}
          </div>` : ""}
          <div class="patch-hover-badge">${patchStatus}</div>
        </div>
      `
      : "";
    card.innerHTML = `
      <div class="port-code">${item.id}</div>
      <div class="port-led ${item.active ? "active-led" : "passive-led"}"></div>
      ${icon ? `<div class="port-icon">${icon}</div>` : ""}
      ${patchPreview}
    `;
    card.title = item.connectedTo
      ? `${formatPortLabel(item)} → ${item.connectedTo}`
      : formatPortLabel(item);
    card.addEventListener("click", () => {
      selectedId = item.id;
      renderAll();
      highlightConnection(item.id);
      scrollToConnection(item.id);
    });
    card.addEventListener("dblclick", () => openQuickConnectModal(item.id));
    if (item.connectedTo) {
      card.addEventListener("mouseenter", () => previewConnection(item.id));
      card.addEventListener("mouseleave", clearPreview);
    }
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openPortContextMenu(item.id, e.clientX, e.clientY);
    });
    attachLongPressMenu(card, item);
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      dragSourceId = item.id;
      card.classList.add("dragging");
      card.classList.add("drag-source");

      const rect = card.getBoundingClientRect();
      dragPreviewPoint = pointFromClient(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );

      if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }

      queueRenderCables();
    });

    card.addEventListener("drag", (e) => {
      if (e.clientX === 0 && e.clientY === 0) return;
      updateDragPreviewPoint(e.clientX, e.clientY);
      startDragAutoScroll(e.clientX, e.clientY);
    });

    card.addEventListener("dragend", () => {
      stopDragAutoScroll();
      card.classList.remove("dragging");
      clearDragVisuals();
      dragSourceId = null;
      clearDragPreviewPoint();
    });
  } else {
    const info = item.connectedFrom
      ? `
        <div class="switch-info compact">
          <span class="switch-type-text">${item.type || "Boş"}</span>
        </div>
  
        <div class="switch-hover-preview">
          <div class="switch-hover-title">${item.id}</div>
  
          <div class="switch-hover-line">
            <span class="switch-hover-label">Patch</span>
            ${item.connectedFrom}
          </div>
  
          <div class="switch-hover-line">
            <span class="switch-hover-label">Kullanıcı</span>
            ${formatAssignment(item)}
          </div>
  
          <div class="switch-hover-badge">
            ${item.type || "Boş"}
          </div>
        </div>
      `
      : `<div class="switch-info compact empty-state"></div>`;
    card.innerHTML = `
    <div class="port-code">${item.id.replace("-", "-<br>")}</div>
      <div class="port-led ${item.active ? "active-led" : "passive-led"}"></div>
      <div class="port-icon">🔌</div>
      ${info}
    `;
    card.title = item.connectedFrom
      ? `${item.id} | ${item.connectedFrom} | ${item.type || "Boş"} | ${formatAssignment(item)}`
      : `${item.id} | Bağlantı yok`;
    card.addEventListener("click", () => {
      const selectedItem = byId(selectedId);

      if (
        isMobileViewport() &&
        selectedItem &&
        isPatch(selectedItem) &&
        selectedItem.id !== item.id
      ) {
        if (item.connectedFrom && item.connectedFrom !== selectedItem.id) {
          showOccupiedSwitchWarning(item);
          return;
        }

        pendingDropTargetId = item.id;
        selectedItem.installed = true;
        selectedItem.active = true;
        openPortModal(selectedItem.id);
        return;
      }

      if (!item.connectedFrom) {
        selectedId = null;
        clearHighlight();
        renderAll();
        return;
      }

      selectedId = item.id;
      renderAll();
      highlightConnection(item.id);
      scrollToConnection(item.id);
    });
    if (item.connectedFrom) {
      card.addEventListener("mouseenter", () => previewConnection(item.id));
      card.addEventListener("mouseleave", clearPreview);
    }
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openPortContextMenu(item.id, e.clientX, e.clientY);
    });
    attachLongPressMenu(card, item);
    card.addEventListener("dragover", (e) => {
      const sourceId = dragSourceId || e.dataTransfer?.getData("text/plain");
      const source = byId(sourceId);
      if (!source || !isPatch(source)) return;
      const valid = isSwitch(item);
      if (!valid) return;

      e.preventDefault();
      updateDragPreviewPoint(e.clientX, e.clientY);
      startDragAutoScroll(e.clientX, e.clientY);

      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      applyDragTargetVisual(item.id);

      const occupiedByAnotherPatch =
        item.connectedFrom && item.connectedFrom !== source.id;

      setDragPreviewState(occupiedByAnotherPatch ? "invalid" : "valid");
    });

    card.addEventListener("dragleave", () => {
      stopDragAutoScroll();
      clearDragVisuals();

      if (dragSourceId) {
        const sourceEl = document.querySelector(
          `[data-port="${dragSourceId}"]`,
        );
        sourceEl?.classList.add("drag-source");
      }

      setDragPreviewState("idle");
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      stopDragAutoScroll();
      clearDragVisuals();
      clearDragPreviewPoint();

      const sourceId = dragSourceId || e.dataTransfer?.getData("text/plain");
      dragSourceId = null;
      const patch = byId(sourceId);
      if (!patch || !isPatch(patch)) return;

      if (item.connectedFrom && item.connectedFrom !== patch.id) {
        showOccupiedSwitchWarning(item);
        return;
      }

      patch.installed = true;
      patch.active = true;
      pendingDropTargetId = item.id;
      selectedId = patch.id;
      openPortModal(patch.id);
    });
  }

  return card;
}

function createRackLayer(device) {
  const layer = document.createElement("div");
  layer.className = "layer-block";

  layer.dataset.deviceId = device.id;

  const head = document.createElement("div");
  head.className = "layer-head";

  const left = document.createElement("div");
  left.className = "layer-head-left";
  left.innerHTML = `
    <span class="badge ${device.colorClass}">
      ${device.title} · ${device.portCount}
    </span>
    <span>${device.kind === "patch" ? "Patch panel portları" : "Switch portları"}</span>
  `;

  const actions = document.createElement("div");
  actions.className = "layer-head-actions";
  actions.innerHTML = `
    <button type="button" class="btn danger rack-delete-btn" data-device-delete="${device.id}">
      Sil
    </button>
  `;

  head.appendChild(left);
  head.appendChild(actions);

  const grid = document.createElement("div");
  grid.className = `port-grid ${getGridClassByPortCount(device.portCount)}`;

  device.ports.forEach((item) => {
    grid.appendChild(createPortCard(item));
  });

  layer.appendChild(head);
  layer.appendChild(grid);

  return layer;
}

function renderRackBuilder() {
  const container = document.getElementById("rackBuilderContainer");
  if (!container) return;

  container.innerHTML = "";

  if (!state.rackDevices.length) {
    renderEmptyRackState();
    return;
  }

  state.rackDevices.forEach((device) => {
    container.appendChild(createRackLayer(device));
  });

  container.querySelectorAll("[data-device-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const deviceId = btn.dataset.deviceDelete;
      const device = getRackDeviceById(deviceId);
      if (!device) return;

      const ok = await showAppConfirm(`"${device.title}" silinsin mi?`, {
        heading: "Cihaz silme onayı",
        subheading: "Bu işlem geri alınamaz",
        title: `"${device.title}" silinsin mi?`,
        message: "Bu cihaza ait tüm bağlantılar kaldırılacak.",
        detail:
          "Cihaz silinince bağlı patch ve switch eşleşmeleri de temizlenir.",
        type: "danger",
        okText: "Sil",
        cancelText: "İptal",
      });
      if (!ok) return;

      removeRackDevice(deviceId);
      await persist();
    });
  });
}

function queryMatch(item, q) {
  if (!q) return true;
  const hay = [
    item.id,
    item.user,
    item.room,
    item.type,
    item.connectedTo,
    item.connectedFrom,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function typeMatch(item) {
  if (selectedType === "Tümü") return true;
  return displayType(item) === selectedType;
}

function filteredItems(items) {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  return items.filter((item) => queryMatch(item, q) && typeMatch(item));
}

function renderStats() {
  const patches = allItems().filter((x) => isPatch(x));
  const switches = allItems().filter((x) => isSwitch(x));

  const installed = patches.filter((x) => x.installed).length;
  const mapped = patches.filter((x) => x.installed && x.connectedTo).length;
  const emptySwitch = switches.filter((x) => !x.connectedFrom).length;
  const pcs = patches.filter((x) => x.installed && x.type === "PC").length;
  const printers = patches.filter(
    (x) => x.installed && x.type === "Yazıcı",
  ).length;
  const cameras = patches.filter(
    (x) => x.installed && x.type === "Kamera",
  ).length;
  const rooms = new Set(
    patches.filter((x) => x.installed && x.room).map((x) => x.room),
  ).size;

  document.getElementById("statInstalled").textContent = installed;
  document.getElementById("statMapped").textContent = mapped;
  document.getElementById("statEmptySwitch").textContent = emptySwitch;
  document.getElementById("statPC").textContent = pcs;
  document.getElementById("statPeripheral").textContent =
    `${printers} / ${cameras}`;
  document.getElementById("statRooms").textContent = rooms;
}

function renderConnectionList() {
  const list = document.getElementById("connectionList");
  list.innerHTML = "";
  const patches = allItems().filter(
    (item) =>
      isPatch(item) &&
      queryMatch(
        item,
        document.getElementById("searchInput").value.trim().toLowerCase(),
      ) &&
      typeMatch(item),
  );

  if (!patches.length) {
    list.innerHTML =
      '<div class="list-item"><strong>Kayıt bulunamadı</strong><small>Arama veya filtre sonucu boş.</small></div>';
    return;
  }

  patches.forEach((item) => {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
    <strong>${item.id}${item.installed ? "" : " · Takılı değil"}</strong>
    <small>
      ${item.connectedTo ? item.connectedTo : "Bağlantı yok"} · ${item.type || "Boş"} · ${formatAssignment(item)}
    </small>
  `;
    row.ondblclick = () => openPortModal(item.id);
    list.appendChild(row);
  });
}

const FLOOR_OPTIONS = ["Giriş Kat", "1. Kat", "2. Kat", "3. Kat", "Sistem Odası"];

function ensureFloorPlansState() {
  if (!state || typeof state !== "object") return {};
  if (!state.floorPlans || typeof state.floorPlans !== "object") {
    state.floorPlans = {};
  }
  return state.floorPlans;
}

function getFloorPlanImage(floorName) {
  const plans = ensureFloorPlansState();
  return typeof plans[floorName] === "string" ? plans[floorName] : "";
}

function getPatchItemsForFloor(floorName, searchText = "") {
  const query = (searchText || "").trim().toLowerCase();

  return allItems().filter((item) => {
    if (!isPatch(item)) return false;
    if (floorName && item.floor !== floorName) return false;

    const hasMeaningfulData = Boolean(
      item.room || item.user || item.installed || item.connectedTo || item.note,
    );

    if (!hasMeaningfulData) return false;

    if (!query) return true;

    const hay = [
      item.id,
      item.room,
      item.user,
      item.connectedTo,
      item.type,
      item.note,
    ]
      .join(" ")
      .toLowerCase();

    return hay.includes(query);
  });
}

function renderFloorPlanViewer() {
  const viewer = document.getElementById("floorPlanViewer");
  const floorSelect = document.getElementById("floorPlanFloorSelect");
  if (!viewer || !floorSelect) return;

  const floorName = floorSelect.value || FLOOR_OPTIONS[0];
  const imageSrc = getFloorPlanImage(floorName);

  if (!imageSrc) {
    viewer.innerHTML = `
      <div class="floor-plan-empty">
        <strong>${floorName} için kat görseli yüklenmedi</strong>
        <div>“Kat görseli yükle” butonuyla bu kata ait krokini ekleyebilirsin.</div>
      </div>
    `;
    return;
  }

  viewer.innerHTML = `
    <div class="floor-plan-image-wrap">
      <img src="${imageSrc}" alt="${floorName} kat planı" />
    </div>
  `;
}

function renderFloorPlanCards() {
  const list = document.getElementById("floorPlanCards");
  const floorSelect = document.getElementById("floorPlanFloorSelect");
  const searchInput = document.getElementById("floorPlanSearch");
  if (!list || !floorSelect || !searchInput) return;

  const floorName = floorSelect.value || FLOOR_OPTIONS[0];
  const items = getPatchItemsForFloor(floorName, searchInput.value);
  list.innerHTML = "";

  if (!items.length) {
    list.innerHTML = '<div class="floor-plan-card-empty">Bu kat için eşleşen birim, kullanıcı veya port bulunamadı.</div>';
    return;
  }

  const grouped = new Map();

  items.forEach((item) => {
    const roomName = (item.room || "Birim atanmadı").trim() || "Birim atanmadı";
    const userName = (item.user || "Kullanıcı atanmadı").trim() || "Kullanıcı atanmadı";
    const key = `${roomName}__${userName}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        roomName,
        userName,
        ports: [],
      });
    }

    grouped.get(key).ports.push(item);
  });

  Array.from(grouped.values())
    .sort((a, b) => `${a.roomName} ${a.userName}`.localeCompare(`${b.roomName} ${b.userName}`, "tr"))
    .forEach((group) => {
      const card = document.createElement("div");
      card.className = "floor-plan-card";
      const linkedCount = group.ports.filter((port) => Boolean(port.connectedTo)).length;
      const emptyCount = group.ports.length - linkedCount;

      const chips = group.ports
        .sort((a, b) => a.id.localeCompare(b.id, "tr"))
        .map((port) => {
          const statusText = port.connectedTo ? port.connectedTo : "BOŞTA";
          const chipClass = port.connectedTo ? "is-linked" : "is-empty";
          return `
            <button type="button" class="floor-plan-port-chip ${chipClass}" data-port-jump="${port.id}">
              <strong>${port.id}</strong>
              <span>${statusText}</span>
            </button>
          `;
        })
        .join("");

      card.innerHTML = `
        <div class="floor-plan-card-head">
          <div>
            <h4>${group.roomName}</h4>
            <div class="meta">${group.userName}</div>
          </div>
          <div class="meta">Toplam: ${group.ports.length} · Bağlı: ${linkedCount} · Boş: ${emptyCount}</div>
        </div>
        <div class="floor-plan-chip-list">${chips}</div>
      `;

      list.appendChild(card);
    });
}

function renderFloorPlanModal() {
  renderFloorPlanViewer();
  renderFloorPlanCards();
}

function openFloorPlanModal() {
  const modal = document.getElementById("floorPlanModal");
  const floorSelect = document.getElementById("floorPlanFloorSelect");
  if (!modal || !floorSelect) return;

  const currentFloorFilter = document.getElementById("floorFilter")?.value;
  floorSelect.value =
    currentFloorFilter && currentFloorFilter !== "Tümü"
      ? currentFloorFilter
      : floorSelect.value || FLOOR_OPTIONS[0];

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  renderFloorPlanModal();
}

function closeFloorPlanModal() {
  const modal = document.getElementById("floorPlanModal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}

async function handleFloorPlanImageUpload(event) {
  const file = event?.target?.files?.[0];
  const floorSelect = document.getElementById("floorPlanFloorSelect");
  if (!file || !floorSelect) return;

  const reader = new FileReader();
  reader.onload = async () => {
    ensureFloorPlansState()[floorSelect.value] = typeof reader.result === "string" ? reader.result : "";
    renderFloorPlanModal();
    event.target.value = "";
    await persist();
  };
  reader.readAsDataURL(file);
}

async function removeFloorPlanImage() {
  const floorSelect = document.getElementById("floorPlanFloorSelect");
  if (!floorSelect) return;
  ensureFloorPlansState()[floorSelect.value] = "";
  renderFloorPlanModal();
  await persist();
}

function renderRoomTopology() {
  const floor = document.getElementById("floorFilter").value;
  const roomText = document
    .getElementById("roomSearch")
    .value.trim()
    .toLowerCase();
  const list = document.getElementById("roomTopologyList");
  list.innerHTML = "";

  const connected = allItems().filter(
    (item) => isSwitch(item) && item.connectedFrom,
  );

  const filtered = connected.filter((item) => {
    if (floor !== "Tümü" && item.floor !== floor) return false;
    const hay = [
      item.room,
      item.user,
      item.connectedFrom,
      item.id,
      item.type,
    ]
      .join(" ")
      .toLowerCase();

    if (roomText && !hay.includes(roomText)) return false;
    return true;
  });

  if (!filtered.length) {
    list.innerHTML =
      '<div class="room-card"><h4>Kayıt yok</h4><div class="meta">Henüz bağlı switch portu bulunmuyor.</div></div>';
    return;
  }

  const grouped = new Map();

  filtered.forEach((item) => {
    const key = (item.room || "Birim atanmadı").trim() || "Birim atanmadı";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });

  Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "tr"))
    .forEach(([roomName, items]) => {
      const people = new Set(
        items.map((x) => (x.user || "").trim()).filter(Boolean),
      );

      const card = document.createElement("div");
      card.className = "room-card";

      const rows = items
        .sort((a, b) => a.id.localeCompare(b.id, "tr"))
        .map(
          (item) => `
            <div class="room-port-row">
              <strong>${item.connectedFrom || "-"}</strong>
              <span>${item.id}</span>
              <span>${item.type || "Boş"}</span>
              <span>${item.user || "-"}</span>
            </div>`,
        )
        .join("");

      card.innerHTML = `
        <h4>${roomName}</h4>
        <div class="meta">Toplam port: ${items.length} · Personel: ${people.size}</div>
        <div class="room-port-list">${rows}</div>
      `;

      list.appendChild(card);
    });
}

function populateTypeSelect() {
  const typeInput = document.getElementById("typeInput");
  typeInput.innerHTML = "";
  DEVICE_TYPES.forEach((type) => {
    const opt = document.createElement("option");
    opt.value = type;
    opt.textContent = type;
    typeInput.appendChild(opt);
  });
}
function populateConnectToSelect(currentPatchId) {
  const select = document.getElementById("connectToInput");
  if (!select) return;

  select.innerHTML = "";
  select.dataset.currentPatchId = currentPatchId || "";

  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "Bağlantı yok";
  emptyOpt.dataset.status = "empty";
  select.appendChild(emptyOpt);

  const switches = allItems().filter((x) => isSwitch(x));

  switches.forEach((sw) => {
    const opt = document.createElement("option");
    opt.value = sw.id;

    const occupiedByAnotherPatch =
      sw.connectedFrom && sw.connectedFrom !== currentPatchId;

    opt.textContent = occupiedByAnotherPatch
      ? `${sw.id} (dolu: ${sw.connectedFrom})`
      : `${sw.id} (boş)`;

    opt.dataset.status = occupiedByAnotherPatch ? "occupied" : "empty";
    opt.dataset.connectedFrom = sw.connectedFrom || "";
    select.appendChild(opt);
  });

  updateConnectWarning();
}
function updateConnectWarning() {
  const select = document.getElementById("connectToInput");
  const warning = document.getElementById("connectToWarning");
  if (!select || !warning) return;

  const selectedOption = select.options[select.selectedIndex];
  if (!selectedOption || !selectedOption.value) {
    warning.classList.add("hidden");
    warning.textContent = "";
    select.classList.remove("input-warning");
    return;
  }

  const isOccupied = selectedOption.dataset.status === "occupied";
  const occupiedBy = selectedOption.dataset.connectedFrom || "";

  if (isOccupied) {
    warning.textContent = `Uyarı: Bu port şu anda ${occupiedBy} tarafından kullanılıyor. Bu porta yeni bağlantı yapılamaz. Önce mevcut bağlantıyı temizlemelisin.`;
    warning.classList.remove("hidden");
    select.classList.add("input-warning");
  } else {
    warning.classList.add("hidden");
    warning.textContent = "";
    select.classList.remove("input-warning");
  }
}
function getFirstAvailableSwitchPort(currentPatchId) {
  return allItems().find((sw) => {
    if (!isSwitch(sw)) return false;

    const occupiedByAnotherPatch =
      sw.connectedFrom && sw.connectedFrom !== currentPatchId;

    return !occupiedByAnotherPatch;
  });
}

function suggestFirstEmptyPort() {
  const currentPatchId = document.getElementById("currentPortId")?.value || "";
  const select = document.getElementById("connectToInput");
  const warning = document.getElementById("connectToWarning");

  if (!select) return;

  const suggested = getFirstAvailableSwitchPort(currentPatchId);

  if (!suggested) {
    select.value = "";
    if (warning) {
      warning.textContent =
        "Uygun boş switch portu bulunamadı. Önce mevcut bağlantılardan birini temizlemelisin.";
      warning.classList.remove("hidden");
    }
    select.classList.add("input-warning");
    return;
  }

  select.value = suggested.id;
  select.classList.remove("input-warning");
  updateConnectWarning();
}
function getAvailableSwitchOptions(searchText = "") {
  const q = (searchText || "").trim().toLowerCase();

  return allItems().filter((sw) => {
    if (!isSwitch(sw)) return false;

    const occupiedByAnotherPatch =
      sw.connectedFrom && sw.connectedFrom !== selectedId;

    if (occupiedByAnotherPatch) return false;
    if (!q) return true;

    return sw.id.toLowerCase().includes(q);
  });
}

function renderQuickConnectList(patchId) {
  const list = document.getElementById("quickConnectList");
  const search = document.getElementById("quickConnectSearch");
  if (!list || !search) return;

  const item = byId(patchId);
  if (!item || !isPatch(item)) return;

  const options = getAvailableSwitchOptions(search.value);

  if (!options.length) {
    list.innerHTML =
      '<div class="quick-connect-empty">Uygun boş port bulunamadı.</div>';
    return;
  }

  list.innerHTML = "";
  options.forEach((sw) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-connect-item";
    btn.innerHTML = `
      <strong>${sw.id}</strong>
      <span>${getRackDeviceFromPort(sw)?.title || "Switch"}</span>
    `;

    btn.onclick = async () => {
      item.installed = true;
      item.active = true;

      if (item.connectedTo && item.connectedTo !== sw.id) {
        clearSwitchBacklink(item.connectedTo);
      }

      if (sw.connectedFrom && sw.connectedFrom !== item.id) {
        const oldPatch = byId(sw.connectedFrom);
        if (oldPatch) oldPatch.connectedTo = null;
      }

      item.connectedTo = sw.id;
      await persist();
      closeQuickConnectModal();
      renderAll();
    };

    list.appendChild(btn);
  });
}

function openQuickConnectModal(patchId) {
  const modal = document.getElementById("quickConnectModal");
  const title = document.getElementById("quickConnectTitle");
  const search = document.getElementById("quickConnectSearch");
  const btnFull = document.getElementById("btnOpenFullPortModal");

  const item = byId(patchId);
  if (!modal || !title || !search || !btnFull || !item || !isPatch(item))
    return;

  selectedId = patchId;
  title.textContent = `${patchId} için Hızlı Bağlama`;
  search.value = "";
  modal.dataset.patchId = patchId;

  renderQuickConnectList(patchId);

  btnFull.onclick = () => {
    closeQuickConnectModal();
    openPortModal(patchId);
  };

  modal.classList.remove("hidden");
}

function closeQuickConnectModal() {
  const modal = document.getElementById("quickConnectModal");
  if (!modal) return;
  modal.classList.add("hidden");
}
function openPortModal(id) {
  selectedId = id;
  const item = byId(id);
  if (!item || isSwitch(item)) return;

  populateConnectToSelect(item.id);
  if (!item.connectedTo) {
    const suggested = getFirstAvailableSwitchPort(item.id);
    if (suggested) {
      document.getElementById("connectToInput").value = suggested.id;
    }
  }
  updateConnectWarning();

  document.getElementById("currentPortId").value = item.id;
  document.getElementById("currentLayer").value = item.layer;
  document.getElementById("portIdInput").value = item.id;
  document.getElementById("layerInput").value = item.layer;
  document.getElementById("floorInput").value = item.floor || "";
  document.getElementById("typeInput").value = item.type || "Boş";
  document.getElementById("roomInput").value = item.room || "";
  document.getElementById("userInput").value = item.user || "";
  document.getElementById("ipInput").value = item.ip || "";
  document.getElementById("noteInput").value = item.note || "";
  document.getElementById("activeInput").checked = !!item.active;
  document.getElementById("installedInput").checked = !!item.installed;
  document.getElementById("connectToInput").value = item.connectedTo || "";
  updateConnectWarning();
  document.getElementById("installedWrap").classList.remove("hidden");
  document.getElementById("btnRemovePatch").classList.remove("hidden");
  document.getElementById("modalTitle").textContent = `${item.id} Düzenle`;
  document.getElementById("modalSubtitle").textContent = item.connectedTo
    ? `${formatPortLabel(item)} şu anda ${item.connectedTo} portuna bağlı.`
    : "Patch portunu çift tıklayarak düzenleyebilir ve switch portu seçebilirsin.";

  document.getElementById("portModal").classList.remove("hidden");
  renderAll();
}

function closePortModal() {
  pendingDropTargetId = null;
  document.getElementById("portModal").classList.add("hidden");
}
function openMappingModal() {
  refreshMappingSelects();
  document.getElementById("mappingModal").classList.remove("hidden");
}
function closeMappingModal() {
  document.getElementById("mappingModal").classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const floorPlanJump = e.target.closest("[data-port-jump]");
  if (floorPlanJump) {
    const portId = floorPlanJump.dataset.portJump;
    selectedId = portId;
    closeFloorPlanModal();
    renderAll();
    highlightConnection(portId);
    scrollPortIntoView(portId);
    return;
  }

  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }

  const menu = document.getElementById("portContextMenu");
  if (menu && !menu.contains(e.target)) {
    closePortContextMenu();
  }

  document.querySelectorAll(".toolbar-menu[open]").forEach((details) => {
    if (!details.contains(e.target)) {
      details.removeAttribute("open");
    }
  });
});
function ensureOccupiedSwitchModal() {
  if (document.getElementById("occupiedSwitchModal")) return;

  const modal = document.createElement("div");
  modal.id = "occupiedSwitchModal";
  modal.className = "modal-overlay hidden";
  modal.innerHTML = `
    <div class="modal-card disconnect-confirm-card occupied-switch-card">
      <div class="modal-head">
        <div>
          <h3>Switch portu dolu</h3>
          <p>Bu porta yeni bağlantı yapamazsın.</p>
        </div>
        <button type="button" class="icon-btn" id="occupiedSwitchClose">✕</button>
      </div>

      <div class="disconnect-confirm-body">
        <div class="disconnect-confirm-icon">⚠️</div>
        <div class="disconnect-confirm-text">
          <strong id="occupiedSwitchTitle">Bu switch portu dolu.</strong>
          <div id="occupiedSwitchPair" class="disconnect-confirm-pair">
            SW1-1 şu anda A-3 tarafından kullanılıyor.
          </div>
          <p id="occupiedSwitchDesc" class="occupied-switch-desc">
            Önce switch portunu ve bağlı olduğu patch portunu temizlemelisin.
          </p>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn primary" id="occupiedSwitchOk">Tamam</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function showOccupiedSwitchWarning(sw) {
  ensureOccupiedSwitchModal();

  const modal = document.getElementById("occupiedSwitchModal");
  const pair = document.getElementById("occupiedSwitchPair");
  const okBtn = document.getElementById("occupiedSwitchOk");
  const closeBtn = document.getElementById("occupiedSwitchClose");

  if (!modal || !pair || !okBtn || !closeBtn || !sw) return;

  const patchId = sw.connectedFrom || "bilinmeyen patch";
  pair.textContent = `${sw.id} portu şu anda ${patchId} tarafından kullanılıyor.`;

  modal.classList.remove("hidden");

  const finish = () => {
    modal.classList.add("hidden");
    okBtn.removeEventListener("click", finish);
    closeBtn.removeEventListener("click", finish);
    modal.removeEventListener("click", handleOverlay);
    document.removeEventListener("keydown", handleKeydown);
  };

  const handleOverlay = (e) => {
    if (e.target === modal) finish();
  };

  const handleKeydown = (e) => {
    if (e.key === "Escape") finish();
  };

  okBtn.addEventListener("click", finish);
  closeBtn.addEventListener("click", finish);
  modal.addEventListener("click", handleOverlay);
  document.addEventListener("keydown", handleKeydown);
}
function clearSwitchBacklink(switchId) {
  const sw = byId(switchId);
  if (!sw || !isSwitch(sw)) return;
  if (sw.connectedFrom) {
    const patch = byId(sw.connectedFrom);
    if (patch) patch.connectedTo = null;
  }
  sw.connectedFrom = null;
  sw.active = false;
  sw.type = "Boş";
  sw.name = "";
  sw.user = "";
  sw.floor = "";
  sw.room = "";
  sw.ip = "";
  sw.note = "";
}

async function savePortFromForm() {
  const id = document.getElementById("currentPortId").value;
  const item = byId(id);
  if (!item || isSwitch(item)) return;

  const installed = document.getElementById("installedInput").checked;
  const active = document.getElementById("activeInput").checked;
  const selectedSwitchId = document.getElementById("connectToInput").value;
  const previousSwitchId = item.connectedTo || "";

  item.floor = document.getElementById("floorInput").value.trim();
  item.room = document.getElementById("roomInput").value.trim();
  item.type = document.getElementById("typeInput").value;
  item.name = "";
  item.user = document.getElementById("userInput").value.trim();
  item.ip = document.getElementById("ipInput").value.trim();
  item.note = document.getElementById("noteInput").value.trim();
  item.active = active;
  item.installed = installed;

  if (!installed) {
    if (item.connectedTo) clearSwitchBacklink(item.connectedTo);
    item.connectedTo = null;
    item.type = "Boş";
    item.user = "";
    item.floor = "";
    item.ip = "";
    item.note = "";
    item.active = false;
    pendingDropTargetId = null;
    await persist();
    closePortModal();
    renderAll();
    return;
  }

  if (pendingDropTargetId) {
    const targetId = pendingDropTargetId;
    pendingDropTargetId = null;
    await connectPortsByDrag(item.id, targetId);
    closePortModal();
    renderAll();
    return;
  }

  const oldConnectedSwitchId = item.connectedTo || "";

  if (
    oldConnectedSwitchId &&
    selectedSwitchId &&
    oldConnectedSwitchId !== selectedSwitchId
  ) {
    const targetSwitch = byId(selectedSwitchId);

    if (
      targetSwitch &&
      isSwitch(targetSwitch) &&
      targetSwitch.connectedFrom &&
      targetSwitch.connectedFrom !== item.id
    ) {
      showOccupiedSwitchWarning(targetSwitch);
      updateConnectWarning();
      return;
    }

    clearSwitchBacklink(oldConnectedSwitchId);
    item.connectedTo = null;
  }

  if (selectedSwitchId) {
    const targetSwitch = byId(selectedSwitchId);

    if (targetSwitch && isSwitch(targetSwitch)) {
      if (
        targetSwitch.connectedFrom &&
        targetSwitch.connectedFrom !== item.id
      ) {
        showOccupiedSwitchWarning(targetSwitch);

        if (item.connectedTo && item.connectedTo !== selectedSwitchId) {
          item.connectedTo = previousSwitchId || null;
        }

        updateConnectWarning();
        return;
      }

      item.connectedTo = selectedSwitchId;
    }
  } else {
    item.connectedTo = null;
  }

  await persist();
  closePortModal();
  renderAll();
}

async function clearPortInfo() {
  const item = byId(document.getElementById("currentPortId").value);
  if (!item || isSwitch(item)) return;

  item.type = "Boş";
  item.name = "";
  item.user = "";
  item.floor = "";
  item.room = "";
  item.ip = "";
  item.note = "";
  item.active = false;
  await persist();
  renderAll();
}

async function removePatch() {
  const item = byId(document.getElementById("currentPortId").value);
  if (!item || !isPatch(item)) return;
  if (item.connectedTo) clearSwitchBacklink(item.connectedTo);
  item.installed = false;
  item.connectedTo = null;
  item.type = "Boş";
  item.name = "";
  item.user = "";
  item.floor = "";
  item.room = "";
  item.ip = "";
  item.note = "";
  item.active = false;
  await persist();
  closePortModal();
  renderAll();
}

function addPatch() {
  openRackDeviceModal("patch");
}

function refreshMappingSelects() {
  const source = document.getElementById("mapSourceSelect");
  const target = document.getElementById("mapTargetSelect");
  source.innerHTML = "";
  target.innerHTML = "";

  const patches = allItems().filter((x) => isPatch(x) && x.installed);
  const switches = allItems().filter((x) => isSwitch(x));

  patches.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = `${item.id} ${item.connectedTo ? `→ ${item.connectedTo}` : ""}`;
    source.appendChild(opt);
  });

  switches.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = `${item.id} ${item.connectedFrom ? `(dolu: ${item.connectedFrom})` : "(boş)"}`;
    target.appendChild(opt);
  });
}

async function saveMapping() {
  const sourceId = document.getElementById("mapSourceSelect").value;
  const targetId = document.getElementById("mapTargetSelect").value;
  const patch = byId(sourceId);
  const sw = byId(targetId);
  if (!patch || !sw) return;
  if (!patch.installed) {
    await showAppAlert({
      heading: "Bağlantı kurulamadı",
      subheading: "Patch aktif değil",
      title: "Önce patch takılı olmalı",
      message: "Bu patch portu takılı olmadığı için bağlantı yapamazsın.",
      desc: "Önce ilgili patch portunu aktif hale getir, sonra switch portuna bağla.",
      type: "warning",
      okText: "Tamam",
    });
    return;
  }
  if (sw.connectedFrom && sw.connectedFrom !== patch.id) {
    showOccupiedSwitchWarning(sw);
    return;
  }

  if (patch.connectedTo && patch.connectedTo !== sw.id) {
    clearSwitchBacklink(patch.connectedTo);
  }

  patch.connectedTo = sw.id;
  await persist();
  closeMappingModal();
  renderAll();
}

async function clearMapping() {
  const sourceId = document.getElementById("mapSourceSelect").value;
  const patch = byId(sourceId);
  if (!patch) return;
  if (patch.connectedTo) clearSwitchBacklink(patch.connectedTo);
  patch.connectedTo = null;
  await persist();
  closeMappingModal();
  renderAll();
}
async function connectPortsByDrag(sourceId, targetId) {
  const patch = byId(sourceId);
  const sw = byId(targetId);

  if (!patch || !sw) return false;
  if (!isPatch(patch) || !isSwitch(sw)) return false;

  patch.installed = true;
  patch.active = true;

  if (sw.connectedFrom && sw.connectedFrom !== patch.id) {
    showOccupiedSwitchWarning(sw);
    return false;
  }

  if (patch.connectedTo && patch.connectedTo !== sw.id) {
    clearSwitchBacklink(patch.connectedTo);
  }

  patch.connectedTo = sw.id;
  await persist();
  return true;
}
function drawCable(svg, x1, y1, x2, y2, color, active, cableId = "") {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  if (cableId) {
    path.setAttribute("data-cable", cableId);
  }
  const dx = Math.abs(x2 - x1);
  const curve = Math.max(36, Math.min(90, dx * 0.28));
  const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", active ? "2.4" : "1.1");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("opacity", active ? "0.72" : "0.14");
  if (cableId) path.dataset.cable = cableId;
  path.style.filter = performanceMode
    ? "none"
    : `drop-shadow(0 0 1px ${color})`;
  svg.appendChild(path);

  if (active && !performanceMode) {
    const circle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    circle.setAttribute("r", "2.4");
    circle.setAttribute("fill", color);
    circle.style.filter = `drop-shadow(0 0 2px ${color})`;
    circle.setAttribute("opacity", "0.55");
    circle.style.pointerEvents = "none";

    const animate = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "animateMotion",
    );
    animate.setAttribute("dur", "8.5s");
    animate.setAttribute("repeatCount", "indefinite");
    animate.setAttribute("path", d);

    circle.appendChild(animate);
    svg.appendChild(circle);
  }
}

function pointFromPortId(portId, layerRect) {
  const { zoomLayer } = getTopologyRefs();
  const card = document.querySelector(`[data-port="${portId}"]`);
  if (!zoomLayer || !card) return null;

  const rect = card.getBoundingClientRect();

  return {
    x: (rect.left - layerRect.left + rect.width / 2) / topologyZoom,
    y: (rect.top - layerRect.top + rect.height / 2) / topologyZoom,
  };
}

function renderCables() {
  const { zoomLayer, svg } = getTopologyRefs();
  if (!zoomLayer || !svg) return;

  const rect = zoomLayer.getBoundingClientRect();

  measureTopologyBaseSize();

  svg.innerHTML = "";
  svg.setAttribute("width", topologyBaseWidth);
  svg.setAttribute("height", topologyBaseHeight);
  svg.setAttribute("viewBox", `0 0 ${topologyBaseWidth} ${topologyBaseHeight}`);
  const allPatches = allItems().filter((x) => isPatch(x));

  allPatches.forEach((patch) => {
    if (!patch.installed || !patch.connectedTo) return;

    const p = pointFromPortId(patch.id, rect);
    const s = pointFromPortId(patch.connectedTo, rect);

    if (!p || !s) return;

    drawCable(
      svg,
      p.x,
      p.y,
      s.x,
      s.y,
      CABLES[patch.type] || CABLES.Boş,
      !!selectedId &&
        (selectedId === patch.id || selectedId === patch.connectedTo),
      `${patch.id}-${patch.connectedTo}`,
    );
  });

  if (dragSourceId && dragPreviewPoint) {
    const sourcePoint = pointFromPortId(dragSourceId, rect);
    const sourceItem = byId(dragSourceId);

    if (sourcePoint && sourceItem && isPatch(sourceItem)) {
      let previewColor = CABLES[sourceItem.type] || CABLES.Boş;

      if (dragPreviewState === "valid") {
        previewColor = "#22c55e";
      } else if (dragPreviewState === "invalid") {
        previewColor = "#ef4444";
      }

      drawPreviewCable(
        svg,
        sourcePoint.x,
        sourcePoint.y,
        dragPreviewPoint.x,
        dragPreviewPoint.y,
        previewColor,
      );
    }
  }
}

function renderAll() {
  renderFilters();
  renderStats();
  renderRackBuilder();
  renderConnectionList();
  renderRoomTopology();

  requestAnimationFrame(() => {
    syncTopologyInteractionMode();

    if (selectedId) {
      const item = byId(selectedId);
      if (item && isPatch(item) && item.connectedTo) {
        highlightConnection(selectedId);
      }
    }
  });
}
let rackDeviceModalKind = "switch";

function getNextPrefix(kind) {
  const count = state.rackDevices.filter((x) => x.kind === kind).length + 1;
  return kind === "patch" ? `P${count}` : `SW${count}`;
}

function getNextTitle(kind) {
  const count = state.rackDevices.filter((x) => x.kind === kind).length + 1;
  return kind === "patch" ? `PATCH PANEL ${count}` : `SWITCH ${count}`;
}

function openRackDeviceModal(kind) {
  rackDeviceModalKind = kind;

  const modal = document.getElementById("rackDeviceModal");
  const title = document.getElementById("rackDeviceModalTitle");
  const kindText = document.getElementById("rackDeviceKindText");
  const deviceTitle = document.getElementById("rackDeviceTitle");
  const portCount = document.getElementById("rackDevicePortCount");
  const codePrefix = document.getElementById("rackDeviceCodePrefix");
  const colorClass = document.getElementById("rackDeviceColorClass");

  title.textContent =
    kind === "patch" ? "Yeni patch panel ekle" : "Yeni switch ekle";
  kindText.value = kind === "patch" ? "Patch Panel" : "Switch";
  deviceTitle.value = getNextTitle(kind);
  portCount.value = kind === "patch" ? "24" : "24";
  codePrefix.value = getNextPrefix(kind);
  colorClass.value = kind === "patch" ? "pink" : "cyan";

  modal.hidden = false;
}

function closeRackDeviceModal() {
  const modal = document.getElementById("rackDeviceModal");
  modal.hidden = true;
}

async function saveRackDeviceFromModal() {
  const title = document.getElementById("rackDeviceTitle").value.trim();
  const portCount = Number(
    document.getElementById("rackDevicePortCount").value,
  );
  const codePrefix = document
    .getElementById("rackDeviceCodePrefix")
    .value.trim();
  const colorClass = document.getElementById("rackDeviceColorClass").value;

  if (!title) {
    await showAppAlert({
      heading: "Eksik bilgi",
      subheading: "Cihaz ekleme formu",
      title: "Başlık boş bırakılamaz",
      message: "Lütfen cihaz için bir başlık gir.",
      desc: "Örnek: SWITCH 1, PATCH PANEL 2 gibi bir isim verebilirsin.",
      type: "warning",
      okText: "Tamam",
    });
    return;
  }

  if (!codePrefix) {
    await showAppAlert({
      heading: "Eksik bilgi",
      subheading: "Cihaz ekleme formu",
      title: "Kod prefix boş bırakılamaz",
      message: "Lütfen cihaz için bir kod prefix gir.",
      desc: "Örnek: SW1, SW2, P1, P2 gibi.",
      type: "warning",
      okText: "Tamam",
    });
    return;
  }

  addRackDevice({
    kind: rackDeviceModalKind,
    title,
    portCount,
    codePrefix,
    colorClass,
  });

  await persist();
  closeRackDeviceModal();
}

function renderEmptyRackState() {
  const container = document.getElementById("rackBuilderContainer");
  if (!container) return;

  if (state.rackDevices.length > 0) return;

  container.innerHTML = `
    <div class="empty-rack-state">
      <h3>Kabinet henüz oluşturulmamış</h3>
      <p>
        İlk kurulum için önce bir patch panel veya switch ekle.
        İstersen sadece switch ile de başlayabilirsin. Eklenen cihazlar yukarıdan aşağı sıralanır.
      </p>
      <div class="empty-rack-actions">
        <button type="button" class="btn ghost" id="emptyAddPatchBtn">+ Patch Ekle</button>
        <button type="button" class="btn primary" id="emptyAddSwitchBtn">+ Switch Ekle</button>
      </div>
    </div>
  `;

  document.getElementById("emptyAddPatchBtn").onclick = () =>
    openRackDeviceModal("patch");
  document.getElementById("emptyAddSwitchBtn").onclick = () =>
    openRackDeviceModal("switch");
}
async function exportData() {
  syncConnections();
  const result = await api.exportData(state);
  if (result?.ok) {
    await showAppAlert({
      heading: "Dışa aktarma tamamlandı",
      subheading: "JSON dosyası hazır",
      title: "JSON başarıyla dışa aktarıldı",
      message: "Proje verileri JSON dosyası olarak dışa aktarıldı.",
      desc: "İndirilen dosyayı yedek olarak saklayabilirsin.",
      type: "success",
      okText: "Tamam",
    });
  }
}

async function importData() {
  const result = await api.importData();
  if (!result?.ok) return;

  try {
    state = normalizeImportedState(result.data);
    selectedId = null;
    clearHighlight();
    const saved = await persist();
    renderAll();

    if (!saved) {
      await showAppAlert("JSON içe aktarıldı ama kaydedilirken hata oluştu.", {
        title: "İçe aktarma tamamlandı",
        subtitle: "Veri yüklendi fakat yerel kayıt başarısız oldu.",
        variant: "warning",
      });
      return;
    }

    await showAppAlert("JSON içe aktarıldı ve kaydedildi.", {
      title: "İçe aktarma tamamlandı",
      subtitle: "Yeni veri başarıyla yüklendi.",
      variant: "success",
    });
  } catch (err) {
    console.error(err);
    await showAppAlert("İçe aktarılan JSON yapısı geçersiz.", {
      title: "Geçersiz JSON",
      subtitle: "Dosya beklenen yapıda değil.",
      variant: "error",
    });
  }
}

async function resetData() {
  if (
    !(await showAppConfirm("Tüm kayıtlar sıfırlansın mı?", {
      title: "Kayıtları sıfırla",
      subtitle: "Program tamamen boş açılacak.",
      detail: "Bu işlem mevcut yerel kaydı temizler.",
      type: "danger",
      okText: "Sıfırla",
      cancelText: "İptal",
      variant: "warning",
    }))
  )
    return;
  state = createInitialState();
  selectedId = null;
  clearHighlight();
  await persist();
  renderAll();
}

function bindEvents() {
  const btnCloseQuickConnect = document.getElementById("btnCloseQuickConnect");
  const quickConnectSearch = document.getElementById("quickConnectSearch");
  const quickConnectModal = document.getElementById("quickConnectModal");

  if (btnCloseQuickConnect) {
    btnCloseQuickConnect.addEventListener("click", closeQuickConnectModal);
  }

  if (quickConnectSearch) {
    quickConnectSearch.addEventListener("input", () => {
      const modal = document.getElementById("quickConnectModal");
      const patchId = modal?.dataset.patchId;
      if (!patchId) return;
      renderQuickConnectList(patchId);
    });
  }

  if (quickConnectModal) {
    quickConnectModal.addEventListener("click", (e) => {
      if (e.target.id === "quickConnectModal") {
        closeQuickConnectModal();
      }
    });
  }
  document.getElementById("searchInput").addEventListener("input", () => {
    selectedId = null;
    clearHighlight();
    renderAll();
  });
  document
    .getElementById("typeFilterSelect")
    .addEventListener("change", (e) => {
      selectedType = e.target.value;
      selectedId = null;
      clearHighlight();
      renderAll();
    });
  document
    .getElementById("roomSearch")
    .addEventListener("input", renderRoomTopology);
  document
    .getElementById("floorFilter")
    .addEventListener("change", renderRoomTopology);
  document.getElementById("btnAddPatchA").onclick = () => addPatch("PATCH-A");
  document.getElementById("btnAddPatchB").onclick = () => addPatch("PATCH-B");
  document.getElementById("btnCloseMapping").onclick = closeMappingModal;
  document.getElementById("btnCloseModal").onclick = closePortModal;
  document.getElementById("btnSavePort").onclick = savePortFromForm;
  document.getElementById("btnSuggestEmptyPort").onclick =
    suggestFirstEmptyPort;
  document.getElementById("btnClearPort").onclick = clearPortInfo;
  document.getElementById("btnRemovePatch").onclick = async () => {
    const portId = document.getElementById("currentPortId").value;
    const item = byId(portId);
    if (!item || !isPatch(item)) return;

    const linkedPortId = item.connectedTo;
    if (linkedPortId) {
      const ok = await askDisconnectConfirmation(item.id, linkedPortId);
      if (!ok) return;
    }

    await removePatch();
  };
  document.getElementById("btnSaveMapping").onclick = saveMapping;
  document
    .getElementById("connectToInput")
    .addEventListener("change", updateConnectWarning);
  document.getElementById("btnClearMapping").onclick = clearMapping;
  document.getElementById("btnExport").onclick = exportData;
  document.getElementById("btnImport").onclick = importData;
  document.getElementById("btnSaveNow").onclick = async () => {
    const saved = await persist();
    if (saved)
      await showAppAlert("Veriler kaydedildi.", {
        title: "Kayıt başarılı",
        subtitle: "Tüm değişiklikler saklandı.",
        variant: "success",
      });
    else
      await showAppAlert("Veriler kaydedilemedi.", {
        title: "Kayıt hatası",
        subtitle: "Yerel kayıt yapılırken sorun oluştu.",
        variant: "error",
      });
  };
  document.getElementById("btnPrint").onclick = () => window.print();
  document.getElementById("btnReset").onclick = resetData;
  document.getElementById("btnPerformanceMode").onclick = () => {
    performanceMode = !performanceMode;
    savePerformanceMode(performanceMode);
    updatePerformanceUI();
    renderAll();
  };
  const addPatchBtn = document.getElementById("addPatchBtn");
  const addSwitchBtn = document.getElementById("addSwitchBtn");
  const btnCloseRackDeviceModal = document.getElementById(
    "btnCloseRackDeviceModal",
  );
  const btnCancelRackDeviceModal = document.getElementById(
    "btnCancelRackDeviceModal",
  );
  const btnSaveRackDeviceModal = document.getElementById(
    "btnSaveRackDeviceModal",
  );
  const rackDeviceModal = document.getElementById("rackDeviceModal");

  if (addPatchBtn) {
    addPatchBtn.addEventListener("click", () => openRackDeviceModal("patch"));
  }

  if (addSwitchBtn) {
    addSwitchBtn.addEventListener("click", () => openRackDeviceModal("switch"));
  }
  const btnFloorPlans = document.getElementById("btnFloorPlans");
  const floorPlanModal = document.getElementById("floorPlanModal");
  const btnCloseFloorPlanModal = document.getElementById("btnCloseFloorPlanModal");
  const floorPlanFloorSelect = document.getElementById("floorPlanFloorSelect");
  const floorPlanSearch = document.getElementById("floorPlanSearch");
  const floorPlanImageInput = document.getElementById("floorPlanImageInput");
  const btnUploadFloorPlan = document.getElementById("btnUploadFloorPlan");
  const btnRemoveFloorPlan = document.getElementById("btnRemoveFloorPlan");

  if (btnFloorPlans) {
    btnFloorPlans.addEventListener("click", openFloorPlanModal);
  }

  if (btnCloseFloorPlanModal) {
    btnCloseFloorPlanModal.addEventListener("click", closeFloorPlanModal);
  }

  if (floorPlanModal) {
    floorPlanModal.addEventListener("click", (e) => {
      if (e.target.id === "floorPlanModal") {
        closeFloorPlanModal();
      }
    });
  }

  if (floorPlanFloorSelect) {
    floorPlanFloorSelect.addEventListener("change", renderFloorPlanModal);
  }

  if (floorPlanSearch) {
    floorPlanSearch.addEventListener("input", renderFloorPlanCards);
  }

  if (btnUploadFloorPlan && floorPlanImageInput) {
    btnUploadFloorPlan.addEventListener("click", () => floorPlanImageInput.click());
    floorPlanImageInput.addEventListener("change", handleFloorPlanImageUpload);
  }

  if (btnRemoveFloorPlan) {
    btnRemoveFloorPlan.addEventListener("click", removeFloorPlanImage);
  }


  if (btnCloseRackDeviceModal) {
    btnCloseRackDeviceModal.addEventListener("click", closeRackDeviceModal);
  }

  if (btnCancelRackDeviceModal) {
    btnCancelRackDeviceModal.addEventListener("click", closeRackDeviceModal);
  }

  if (btnSaveRackDeviceModal) {
    btnSaveRackDeviceModal.addEventListener("click", saveRackDeviceFromModal);
  }

  if (rackDeviceModal) {
    rackDeviceModal.addEventListener("click", (e) => {
      if (e.target.id === "rackDeviceModal") {
        closeRackDeviceModal();
      }
    });
  }
  function isDesktopMode() {
    return window.innerWidth >= 1025;
  }

  function syncDesktopTopologyMode() {
    const stage = document.getElementById("topologyStage");
    const controls = document.getElementById("topologyZoomControls");
    const zoomLayer = document.getElementById("topologyZoomLayer");
    const zoomShell = document.getElementById("topologyZoomShell");

    if (!stage || !controls || !zoomLayer || !zoomShell) return;

    if (isDesktopMode()) {
      controls.style.display = "none";
      topologyZoom = 1;
      zoomLayer.style.transform = "none";
      zoomLayer.style.width = "100%";
      zoomShell.style.width = "100%";
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    } else {
      controls.style.display = "";
      updateTopologyZoomLayout(false);
    }
  }
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomFitBtn = document.getElementById("zoomFitBtn");

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      setTopologyZoom(topologyZoom - TOPOLOGY_ZOOM_STEP, false);

      const stage = document.getElementById("topologyStage");
      if (stage) {
        stage.scrollTop = 0;
      }

      syncDesktopTopologyMode();
    });
  }

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      setTopologyZoom(topologyZoom + TOPOLOGY_ZOOM_STEP, false);

      const stage = document.getElementById("topologyStage");
      if (stage) {
        stage.scrollTop = 0;
      }

      syncDesktopTopologyMode();
    });
  }

  if (zoomFitBtn) {
    zoomFitBtn.addEventListener("click", () => {
      fitTopologyToScreen();
      syncDesktopTopologyMode();
    });
  }
  window.addEventListener("resize", () => {
    clearHighlight();

    if (isDesktopMode()) {
      syncDesktopTopologyMode();
      return;
    }

    updateTopologyZoomLayout(false);
    requestAnimationFrame(() => updateTopologyZoomLayout(false));
  });
  document.getElementById("topologyStage").addEventListener("click", (e) => {
    const clickedPort = e.target.closest("[data-port]");
    if (clickedPort) return;

    selectedId = null;
    clearHighlight();

    if (isTouchZoomLayout()) {
      fitTopologyToScreen();
    }

    renderAll();
  });
  document.getElementById("topologyStage").addEventListener(
    "touchend",
    (e) => {
      const touchedPort = e.target.closest("[data-port]");
      if (touchedPort) return;
      if (longPressTriggered) return;

      selectedId = null;
      clearHighlight();

      if (isTouchZoomLayout()) {
        fitTopologyToScreen();
      }

      renderAll();
    },
    { passive: true },
  );
  const topologyStage = document.getElementById("topologyStage");

  topologyStage.addEventListener(
    "wheel",
    (e) => {
      if (isDesktopMode()) {
        return;
      }

      const mostlyVertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);

      if (mostlyVertical) {
        e.preventDefault();
        window.scrollBy({
          top: e.deltaY,
          behavior: "auto",
        });
        return;
      }

      topologyStage.scrollLeft += e.deltaX;
    },
    { passive: false },
  );
  ensurePortContextMenu();
  ensureDisconnectConfirmModal();

  document.addEventListener("scroll", closePortContextMenu, true);
  window.addEventListener("resize", closePortContextMenu);

  document
    .getElementById("portContextMenu")
    .addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const action = btn.dataset.action;
      const portId = contextMenuPortId;

      if (!portId) {
        closePortContextMenu();
        return;
      }

      if (action === "highlight") {
        selectedId = portId;
        renderAll();
        highlightConnection(portId);
        scrollToConnection(portId);
        closePortContextMenu();
        return;
      }

      if (action === "goto") {
        const linkedPortId = getLinkedPortId(portId);
        if (linkedPortId) {
          scrollPortIntoView(linkedPortId);
        }
        closePortContextMenu();
        return;
      }

      if (action === "disconnect") {
        const linkedPortId = getLinkedPortId(portId);
        if (!linkedPortId) {
          closePortContextMenu();
          return;
        }
        const ok = await askDisconnectConfirmation(portId, linkedPortId);
        if (!ok) {
          closePortContextMenu();
          return;
        }

        await disconnectPortConnection(portId);
        closePortContextMenu();
      }
    });
  document.getElementById("portModal").addEventListener("click", (e) => {
    if (e.target.id === "portModal") closePortModal();
  });
  document.getElementById("mappingModal").addEventListener("click", (e) => {
    if (e.target.id === "mappingModal") closeMappingModal();
  });
}

function setupMobileNavigation() {
  const body = document.body;
  const tabs = Array.from(document.querySelectorAll(".mobile-tab"));
  const toolsSheet = document.getElementById("mobileToolsSheet");
  const toolsClose = document.getElementById("mobileToolsClose");
  const mobileSearchInput = document.getElementById("mobileSearchInput");
  const mainSearchInput = document.getElementById("searchInput");
  const mobileTypeFilterSelect = document.getElementById(
    "mobileTypeFilterSelect",
  );
  const mainTypeFilterSelect = document.getElementById("typeFilterSelect");

  if (!tabs.length) return;

  const syncActiveTab = (view = "rack") => {
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mobileView === view);
    });
  };

  const closeMobilePanels = () => {
    body.classList.remove(
      "mobile-connections-open",
      "mobile-summary-open",
      "mobile-tools-open",
    );
    syncActiveTab("rack");
    if (toolsSheet) toolsSheet.setAttribute("aria-hidden", "true");
  };

  const openMobileView = (view) => {
    body.classList.remove(
      "mobile-connections-open",
      "mobile-summary-open",
      "mobile-tools-open",
    );

    if (view === "connections") {
      body.classList.add("mobile-connections-open");
    } else if (view === "summary") {
      body.classList.add("mobile-summary-open");
    } else if (view === "tools") {
      body.classList.add("mobile-tools-open");
      if (toolsSheet) toolsSheet.setAttribute("aria-hidden", "false");
    }

    syncActiveTab(view);
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.mobileView || "rack";
      if (view === "rack") {
        closeMobilePanels();
        return;
      }

      const isAlreadyOpen =
        (view === "connections" &&
          body.classList.contains("mobile-connections-open")) ||
        (view === "summary" &&
          body.classList.contains("mobile-summary-open")) ||
        (view === "tools" && body.classList.contains("mobile-tools-open"));

      if (isAlreadyOpen) {
        closeMobilePanels();
        return;
      }

      openMobileView(view);
    });
  });

  document.querySelectorAll("[data-mobile-close]").forEach((el) => {
    el.addEventListener("click", closeMobilePanels);
  });

  if (toolsClose) toolsClose.addEventListener("click", closeMobilePanels);

  document.querySelectorAll("[data-proxy-click]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.proxyClick);
      if (target) target.click();
    });
  });

  if (mobileSearchInput && mainSearchInput) {
    const syncSearchValue = (value, source) => {
      if (source !== mobileSearchInput) mobileSearchInput.value = value;
      if (source !== mainSearchInput) mainSearchInput.value = value;
    };

    mobileSearchInput.addEventListener("input", () => {
      mainSearchInput.value = mobileSearchInput.value;
      mainSearchInput.dispatchEvent(new Event("input", { bubbles: true }));
      syncSearchValue(mobileSearchInput.value, mobileSearchInput);
    });

    mainSearchInput.addEventListener("input", () => {
      syncSearchValue(mainSearchInput.value, mainSearchInput);
    });

    syncSearchValue(mainSearchInput.value || "", null);
  }

  if (mobileTypeFilterSelect && mainTypeFilterSelect) {
    const syncTypeOptions = () => {
      mobileTypeFilterSelect.innerHTML = mainTypeFilterSelect.innerHTML;
      mobileTypeFilterSelect.value = mainTypeFilterSelect.value;
    };

    syncTypeOptions();

    mobileTypeFilterSelect.addEventListener("change", () => {
      mainTypeFilterSelect.value = mobileTypeFilterSelect.value;
      mainTypeFilterSelect.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    });

    mainTypeFilterSelect.addEventListener("change", syncTypeOptions);
  }

  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeMobilePanels();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMobilePanels();
  });
}

async function init() {
  performanceMode = loadPerformanceMode();
  updatePerformanceUI();
  populateTypeSelect();
  bindEvents();
  setupMobileNavigation();
  updateSaveStatusUI();

  const loaded = await api.loadData();
  state =
    loaded && !loaded.error
      ? normalizeImportedState(loaded)
      : createInitialState();

  if (!state.rackDevices || !Array.isArray(state.rackDevices)) {
    state = createInitialState();
  }

  syncConnections();
  const saved = await persist();
  if (!saved) {
    await showAppAlert("Kayıtlı veriler yüklenirken kaydetme hatası oluştu.", {
      title: "Başlangıç uyarısı",
      subtitle: "Veri yüklendi fakat tekrar kaydetme sırasında hata oldu.",
      variant: "warning",
    });
  }
  renderAll();

  requestAnimationFrame(() => {
    if (isTouchZoomLayout()) {
      topologyZoom = window.innerWidth <= 768 ? 0.82 : 1;
    } else {
      topologyZoom = 1;
    }

    syncTopologyInteractionMode();
  });
  window.addEventListener("resize", () => {
    requestAnimationFrame(() => {
      refreshTopologyLayoutNow();
    });
  });
}

init();

const AUTH_STORAGE_KEY = "network_console_local_pin";
let authEnteredPin = "";
let setupCreatePin = "";
let setupConfirmPin = "";
let setupStep = "create";
function setAppViewport(mode) {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;

  if (mode === "desktop") {
    viewport.setAttribute("content", "width=1400");
  } else {
    viewport.setAttribute("content", "width=device-width, initial-scale=1.0");
  }
}

function authEl(id) {
  return document.getElementById(id);
}
function getStoredPin() {
  return localStorage.getItem(AUTH_STORAGE_KEY);
}
function setStoredPin(pin) {
  localStorage.setItem(AUTH_STORAGE_KEY, pin);
}
function updateAuthCells(cells, value) {
  if (!cells) return;
  cells.forEach((cell, index) =>
    cell.classList.toggle("filled", index < value.length),
  );
}
function setAuthStatus(el, message, type = "") {
  if (!el) return;
  el.textContent = message;
  el.classList.remove("error", "success");
  if (type) el.classList.add(type);
}
function refreshTopologyAfterAuth() {
  const runLayoutPass = () => {
    syncTopologyInteractionMode();

    requestAnimationFrame(() => {
      syncTopologyInteractionMode();
      fitTopologyToScreen();
      updateTopologyZoomLayout(false);
      queueRenderCables();

      requestAnimationFrame(() => {
        fitTopologyToScreen();
        updateTopologyZoomLayout(false);
        queueRenderCables();
        window.dispatchEvent(new Event("resize"));

        requestAnimationFrame(() => {
          fitTopologyToScreen();
          updateTopologyZoomLayout(false);
          queueRenderCables();
        });
      });
    });
  };

  requestAnimationFrame(runLayoutPass);

  setTimeout(runLayoutPass, 120);
  setTimeout(runLayoutPass, 260);
}

function showAuthScreen(targetId) {
  ["setupScreen", "loginScreen", "appScreen"].forEach((id) =>
    authEl(id)?.classList.add("hidden"),
  );

  authEl(targetId)?.classList.remove("hidden");
  document.body.classList.toggle("authenticated", targetId === "appScreen");
  document.body.classList.toggle("auth-locked", targetId !== "appScreen");

  if (targetId === "appScreen") {
    setAppViewport("desktop");

    setTimeout(() => {
      refreshTopologyAfterAuth();
    }, 50);
  } else {
    setAppViewport("mobile");
  }
}
function resetLoginPin() {
  authEnteredPin = "";
  updateAuthCells(
    Array.from(document.querySelectorAll("#pinBoxes .pin-cell")),
    authEnteredPin,
  );
}
function resetSetupPins() {
  setupCreatePin = "";
  setupConfirmPin = "";
  setupStep = "create";
  updateAuthCells(
    Array.from(document.querySelectorAll("#createPinBoxes .pin-cell")),
    setupCreatePin,
  );
  updateAuthCells(
    Array.from(document.querySelectorAll("#confirmPinBoxes .pin-cell")),
    setupConfirmPin,
  );
  setAuthStatus(authEl("setupStatus"), "4 haneli PIN oluştur");
}
function shakeCard(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-10px)" },
      { transform: "translateX(10px)" },
      { transform: "translateX(-8px)" },
      { transform: "translateX(8px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 420, easing: "ease-out" },
  );
}
function handleLoginDigit(digit) {
  if (authEnteredPin.length >= 4) return;
  authEnteredPin += digit;
  updateAuthCells(
    Array.from(document.querySelectorAll("#pinBoxes .pin-cell")),
    authEnteredPin,
  );
  if (authEnteredPin.length === 4) {
    const ok = authEnteredPin === getStoredPin();
    if (ok) {
      setAuthStatus(authEl("statusText"), "Erişim onaylandı", "success");
      setTimeout(() => {
        showAuthScreen("appScreen");
        resetLoginPin();
      }, 240);
    } else {
      setAuthStatus(authEl("statusText"), "Hatalı PIN", "error");
      shakeCard(".auth-panel");
      setTimeout(resetLoginPin, 350);
    }
  }
}
function handleSetupDigit(digit) {
  if (setupStep === "create") {
    if (setupCreatePin.length >= 4) return;
    setupCreatePin += digit;
    updateAuthCells(
      Array.from(document.querySelectorAll("#createPinBoxes .pin-cell")),
      setupCreatePin,
    );
    if (setupCreatePin.length === 4) {
      setupStep = "confirm";
      setAuthStatus(authEl("setupStatus"), "PIN tekrar girin");
    }
    return;
  }
  if (setupConfirmPin.length >= 4) return;
  setupConfirmPin += digit;
  updateAuthCells(
    Array.from(document.querySelectorAll("#confirmPinBoxes .pin-cell")),
    setupConfirmPin,
  );
  if (setupConfirmPin.length === 4) {
    if (setupCreatePin === setupConfirmPin) {
      setStoredPin(setupCreatePin);
      setAuthStatus(authEl("setupStatus"), "PIN kaydedildi", "success");
      setTimeout(() => {
        resetSetupPins();
        resetLoginPin();
        setAuthStatus(authEl("statusText"), "PIN giriniz");
        showAuthScreen("loginScreen");
      }, 260);
    } else {
      setAuthStatus(authEl("setupStatus"), "PIN eşleşmedi", "error");
      shakeCard(".setup-card");
      setTimeout(resetSetupPins, 420);
    }
  }
}
function bindAuthKeypad() {
  document.querySelectorAll("#loginScreen .key").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (key) handleLoginDigit(key);
      if (action === "clear") {
        resetLoginPin();
        setAuthStatus(authEl("statusText"), "PIN giriniz");
      }
      if (action === "delete") {
        authEnteredPin = authEnteredPin.slice(0, -1);
        updateAuthCells(
          Array.from(document.querySelectorAll("#pinBoxes .pin-cell")),
          authEnteredPin,
        );
      }
    });
  });
  document.querySelectorAll("#setupKeypad .key").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (key) handleSetupDigit(key);
      if (action === "clear") {
        resetSetupPins();
      }
      if (action === "delete") {
        if (setupStep === "confirm" && setupConfirmPin.length) {
          setupConfirmPin = setupConfirmPin.slice(0, -1);
          updateAuthCells(
            Array.from(document.querySelectorAll("#confirmPinBoxes .pin-cell")),
            setupConfirmPin,
          );
        } else if (setupStep === "create" && setupCreatePin.length) {
          setupCreatePin = setupCreatePin.slice(0, -1);
          updateAuthCells(
            Array.from(document.querySelectorAll("#createPinBoxes .pin-cell")),
            setupCreatePin,
          );
        }
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    const activeSetup = !authEl("setupScreen")?.classList.contains("hidden");
    const activeLogin = !authEl("loginScreen")?.classList.contains("hidden");
    if (!activeSetup && !activeLogin) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      activeSetup ? handleSetupDigit(event.key) : handleLoginDigit(event.key);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (activeSetup) {
        if (setupStep === "confirm" && setupConfirmPin.length) {
          setupConfirmPin = setupConfirmPin.slice(0, -1);
          updateAuthCells(
            Array.from(document.querySelectorAll("#confirmPinBoxes .pin-cell")),
            setupConfirmPin,
          );
        } else if (setupCreatePin.length) {
          setupCreatePin = setupCreatePin.slice(0, -1);
          updateAuthCells(
            Array.from(document.querySelectorAll("#createPinBoxes .pin-cell")),
            setupCreatePin,
          );
        }
      } else {
        authEnteredPin = authEnteredPin.slice(0, -1);
        updateAuthCells(
          Array.from(document.querySelectorAll("#pinBoxes .pin-cell")),
          authEnteredPin,
        );
      }
    }
  });
  authEl("logoutBtn")?.addEventListener("click", () => {
    resetLoginPin();
    setAuthStatus(authEl("statusText"), "PIN giriniz");
    showAuthScreen("loginScreen");
  });
}
function initAuthGate() {
  bindAuthKeypad();
  if (getStoredPin()) {
    setAuthStatus(authEl("statusText"), "PIN giriniz");
    showAuthScreen("loginScreen");
  } else {
    resetSetupPins();
    showAuthScreen("setupScreen");
  }
}

initAuthGate();
