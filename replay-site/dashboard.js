const API = "/api";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const activeStatuses = new Set(["queued", "running", "awaiting_approval", "awaiting_input"]);
const statusLabels = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Approval needed",
  awaiting_input: "Needs your input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const eventLabels = {
  plan: "Plan",
  thought: "Decision note",
  action: "Browser action",
  observation: "Observation",
  memory: "Remembered fact",
  retry: "Retry",
  approval: "Approval",
  verification: "Verification",
  error: "Error",
  complete: "Completion",
};

const $ = (selector, root = document) => root.querySelector(selector);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

let currentRun = null;
let runHistory = [];
let health = null;
let lastScreenshotKey = "";
let pollBusy = false;
let historyBusy = false;
let memoryLoaded = false;
let lastApprovalKey = "";

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  let payload = null;
  if (response.status !== 204) {
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) payload = await response.json();
    else payload = await response.text();
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.error || payload.message : payload;
    throw new Error(detail ? String(detail) : `Request failed (${response.status})`);
  }
  return payload;
}

function jsonBody(value) { return JSON.stringify(value); }

function setMessage(message, tone = "info") {
  const region = $("#app-message");
  region.textContent = message || "";
  region.dataset.tone = tone;
  region.hidden = !message;
}

function setInlineMessage(region, message, tone = "info") {
  region.textContent = message || "";
  region.dataset.tone = tone;
  region.hidden = !message;
}

function formatDate(value, includeTime = false) {
  if (!value) return "Date not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const options = includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function safeLinkUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function setCurrentView(view) {
  const memory = view === "memory";
  $("#workspace-view").hidden = memory;
  $("#memory-view").hidden = !memory;
  document.querySelectorAll("[data-view-button]").forEach((button) => {
    const selected = button.dataset.viewButton === view;
    button.classList.toggle("is-current", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (memory && !memoryLoaded) void loadMemory();
}

function renderHealth() {
  const label = $("#model-label");
  if (!health) return;
  const provider = health.provider || "Provider not reported";
  const model = health.model || "Model not reported";
  const readiness = health.modelReady === true ? "ready" : health.modelReady === false ? "not ready" : "status unknown";
  label.textContent = `${provider} · ${model} · ${readiness}`;
  label.classList.toggle("is-error", health.modelReady === false);
}

async function loadHealth() {
  try {
    health = await request("/health");
    renderHealth();
    if (health.modelReady === false) setMessage("The configured model is not ready. Check the server configuration before starting a run.", "error");
    return health;
  } catch (error) {
    $("#model-label").textContent = "Worker status unavailable";
    $("#model-label").classList.add("is-error");
    setMessage(`Could not reach the worker health endpoint: ${error.message}`, "error");
    return null;
  }
}

function runOptionLabel(run) {
  const task = (run.task || "Untitled task").replace(/\s+/g, " ").trim();
  const shortTask = task.length > 58 ? `${task.slice(0, 55)}…` : task;
  const status = statusLabels[run.status] || run.status || "Unknown";
  return `${status} · ${shortTask}`;
}

function renderHistoryOptions() {
  const select = $("#run-history");
  const selected = currentRun?.id || "__new__";
  const options = [new Option("New task", "__new__")];
  runHistory.forEach((run) => options.push(new Option(runOptionLabel(run), run.id)));
  select.replaceChildren(...options);
  select.value = runHistory.some((run) => run.id === selected) ? selected : "__new__";
}

async function refreshHistory() {
  if (historyBusy) return;
  historyBusy = true;
  try {
    const result = await request("/runs");
    runHistory = Array.isArray(result) ? result.slice() : [];
    runHistory.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    renderHistoryOptions();
  } catch (error) {
    if (!currentRun) setMessage(`Run history is unavailable: ${error.message}`, "error");
  } finally {
    historyBusy = false;
  }
}

function setStatus(status) {
  const badge = $("#run-status");
  badge.textContent = statusLabels[status] || (status ? String(status) : "Ready");
  badge.className = `status-badge ${status ? `status-${status}` : "status-idle"}`;
}

function eventSignature(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  return events.length ? `${events.length}:${events.at(-1)?.id || events.at(-1)?.time || "last"}` : "empty";
}

function renderPlan(run) {
  const region = $("#run-plan-region");
  const list = $("#run-plan");
  list.replaceChildren();
  if (!Array.isArray(run?.plan) || !run.plan.length) {
    region.hidden = true;
    return;
  }
  run.plan.forEach((step) => list.append(make("li", "", step)));
  $("#plan-count").textContent = `${run.plan.length} steps`;
  region.hidden = false;
}

function renderEvents(run) {
  const list = $("#event-list");
  const empty = $("#empty-activity");
  const events = Array.isArray(run?.events) ? run.events : [];
  const renderKey = run ? `${run.id}:${eventSignature(run)}` : "none";
  if (list.dataset.renderKey !== renderKey) {
    const sameRun = list.dataset.runId === (run?.id || "");
    const previousScrollTop = sameRun ? list.scrollTop : 0;
    const wasAtBottom = !sameRun || list.scrollHeight - list.scrollTop - list.clientHeight <= 8;
    const expandedEventIds = sameRun
      ? new Set(Array.from(list.querySelectorAll("details[open][data-event-id]"), (details) => details.dataset.eventId))
      : new Set();

    list.replaceChildren();
    events.forEach((event, index) => {
      const eventId = String(event.id || `${event.time || "event"}-${index}`);
      const item = make("li", "event-item");
      item.dataset.type = event.type || "event";
      item.dataset.eventId = eventId;
      item.append(make("span", "event-marker"));
      const body = make("div", "event-body");
      const meta = make("div", "event-meta");
      meta.append(make("span", "event-type", eventLabels[event.type] || event.type || "Event"));
      if (event.time) meta.append(make("time", "event-time", formatTime(event.time)));
      body.append(meta, make("p", "event-message", event.message || "No event description"));
      if (event.data !== undefined && event.data !== null) {
        const details = make("details", "event-details");
        details.dataset.eventId = eventId;
        details.open = expandedEventIds.has(eventId);
        details.append(make("summary", "", "Inspect event data"));
        const pre = make("pre", "");
        try { pre.textContent = JSON.stringify(event.data, null, 2); }
        catch { pre.textContent = String(event.data); }
        details.append(pre);
        body.append(details);
      }
      item.append(body);
      list.append(item);
    });

    list.dataset.renderKey = renderKey;
    list.dataset.runId = run?.id || "";
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = wasAtBottom ? maxScrollTop : Math.min(previousScrollTop, maxScrollTop);
  }
  empty.hidden = events.length > 0;
  const count = $("#step-count");
  if (run && Number.isFinite(run.steps) && run.steps > 0) {
    count.textContent = `${run.steps} browser ${run.steps === 1 ? "decision" : "decisions"} recorded`;
    count.hidden = false;
  } else count.hidden = true;
}

function renderApproval(run) {
  const panel = $("#approval-panel");
  const pending = run?.status === "awaiting_approval" && run.approval;
  panel.hidden = !pending;
  if (pending) {
    $("#approval-question").textContent = run.approval.question || "The worker is waiting for approval to continue.";
    $("#approval-detail-text").textContent = run.approval.details || "No additional details were provided.";
    const approvalKey = `${run.id}:${run.approval.question || ""}:${run.approval.details || ""}`;
    if (approvalKey !== lastApprovalKey) $(".approval-details", panel).open = true;
    lastApprovalKey = approvalKey;
  } else {
    lastApprovalKey = "";
  }
  const answerPanel = $("#answer-panel");
  const needsAnswer = run?.status === "awaiting_input" && run.question;
  answerPanel.hidden = !needsAnswer;
  if (needsAnswer) $("#answer-question").textContent = run.question;
}

function renderVerification(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const hasSource = events.some((event) => event.type === "observation") || (run?.evidence?.length || 0) > 0;
  const hasApproval = events.some((event) => event.type === "approval");
  const completed = run?.status === "completed";
  const failed = run?.status === "failed" || run?.status === "cancelled";

  const sourceStep = $("#source-step");
  const approvalStep = $("#approval-step");
  const resultStep = $("#result-step");
  sourceStep.className = `verification-step${hasSource ? " is-observed" : ""}`;
  approvalStep.className = `verification-step${run?.status === "awaiting_approval" ? " is-approved" : hasApproval && completed ? " is-approved" : ""}`;
  resultStep.className = `verification-step${completed ? " is-verified" : failed ? " is-error" : ""}`;

  $("#source-step-detail").textContent = hasSource ? "Source material was observed" : "Waiting for a source observation";
  $("#approval-step-detail").textContent = run?.status === "awaiting_approval"
    ? "Review is required before the proposed write"
    : hasApproval && completed
      ? "Approval was recorded for this run"
      : completed
        ? "No approval checkpoint was requested"
        : "No change is authorized yet";
  $("#result-step-detail").textContent = completed
    ? "Saved result passed the worker's evidence checks"
    : failed
      ? "No verified completion was recorded"
      : "Not verified";
  $("#verification-caption").textContent = completed
    ? "The run completed after its evidence checks passed."
    : failed
      ? "This run did not complete successfully; no verified result is shown."
      : "A result is marked verified only after the worker checks the persisted change.";

  const summary = $("#run-summary");
  summary.textContent = completed ? (run.summary || "The worker completed and verified this run.") : "";
  summary.hidden = !completed;

  const links = $("#evidence-links");
  links.replaceChildren();
  (Array.isArray(run?.evidence) ? run.evidence : []).forEach((item) => {
    const href = safeLinkUrl(item.url);
    if (!href) return;
    const link = make("a", "", item.label || "Open evidence");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    links.append(link);
  });
}

function renderScreenshot(run, force = false) {
  const image = $("#run-screenshot");
  const empty = $("#screenshot-empty");
  const caption = $("#screenshot-caption");
  const fullSizeCapture = $("#full-size-capture");
  const events = Array.isArray(run?.events) ? run.events : [];
  const signature = run ? `${run.id}:${eventSignature(run)}:${run.screenshotUrl || ""}` : "none";
  if (!run || !events.length) {
    image.hidden = true;
    image.removeAttribute("src");
    fullSizeCapture.hidden = true;
    fullSizeCapture.removeAttribute("href");
    empty.hidden = false;
    caption.textContent = "No browser capture yet";
    lastScreenshotKey = signature;
    return;
  }
  if (!force && signature === lastScreenshotKey) return;
  lastScreenshotKey = signature;
  const cacheKey = encodeURIComponent(events.at(-1)?.id || events.at(-1)?.time || String(events.length));
  const screenshotUrl = run.screenshotUrl || `/api/runs/${encodeURIComponent(run.id)}/screenshot`;
  const separator = screenshotUrl.includes("?") ? "&" : "?";
  const src = `${screenshotUrl}${separator}v=${cacheKey}`;
  const fullSizeUrl = run.screenshotUrl ? safeLinkUrl(src) : null;
  image.hidden = true;
  fullSizeCapture.hidden = true;
  if (fullSizeUrl) fullSizeCapture.href = fullSizeUrl;
  else fullSizeCapture.removeAttribute("href");
  empty.hidden = false;
  empty.querySelector("p").textContent = "Loading the latest browser capture…";
  caption.textContent = "Capture from the latest recorded event";
  image.onload = () => {
    image.hidden = false;
    empty.hidden = true;
    fullSizeCapture.hidden = !fullSizeUrl;
  };
  image.onerror = () => {
    image.hidden = true;
    empty.hidden = false;
    fullSizeCapture.hidden = true;
    empty.querySelector("p").textContent = "No screenshot is available for this event yet.";
    caption.textContent = "Screenshot unavailable for the latest event";
  };
  image.src = src;
}

function renderRun(run) {
  currentRun = run || null;
  const taskLabel = $("#run-task-label");
  taskLabel.textContent = run ? run.task || "Untitled task" : "No run selected";
  setStatus(run?.status);
  $("#stop-run").hidden = !run || !activeStatuses.has(run.status);
  $("#start-run").disabled = Boolean(run && activeStatuses.has(run.status));
  renderPlan(run);
  renderEvents(run);
  renderApproval(run);
  renderVerification(run);
  renderScreenshot(run);
  renderHistoryOptions();
}

async function loadRun(id) {
  try {
    const run = await request(`/runs/${encodeURIComponent(id)}`);
    lastScreenshotKey = "";
    renderRun(run);
    setMessage("", "info");
    return run;
  } catch (error) {
    setMessage(`Could not load this run: ${error.message}`, "error");
    return null;
  }
}

async function startRun(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const startButton = $("#start-run");
  startButton.disabled = true;
  startButton.querySelector("span:first-child").textContent = "Starting…";
  setMessage("Submitting the task to the worker…", "info");
  try {
    const run = await request("/runs", {
      method: "POST",
      body: jsonBody({ task: $("#task-input").value.trim(), injectFailure: $("#inject-failure").checked }),
    });
    lastScreenshotKey = "";
    renderRun(run);
    await refreshHistory();
    setMessage("Run started. Actions and observations will appear in the activity record.", "success");
  } catch (error) {
    setMessage(`The run could not be started: ${error.message}`, "error");
    startButton.disabled = false;
  } finally {
    startButton.querySelector("span:first-child").textContent = "Start run";
    if (currentRun && activeStatuses.has(currentRun.status)) startButton.disabled = true;
  }
}

async function respondToApproval(approved) {
  if (!currentRun) return;
  const buttons = [$("#approve-change"), $("#reject-change")];
  buttons.forEach((button) => { button.disabled = true; });
  setMessage(approved ? "Sending approval…" : "Rejecting the proposed change…", "info");
  try {
    const run = await request(`/runs/${encodeURIComponent(currentRun.id)}/approve`, {
      method: "POST",
      body: jsonBody({ approved }),
    });
    renderRun(run?.id ? run : await request(`/runs/${encodeURIComponent(currentRun.id)}`));
    setMessage(approved ? "Approval recorded. The worker can continue." : "Change rejected. The worker has been notified.", approved ? "success" : "info");
    await refreshHistory();
  } catch (error) {
    setMessage(`Could not submit your decision: ${error.message}`, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function sendAnswer(event) {
  event.preventDefault();
  if (!currentRun) return;
  const input = $("#answer-input");
  const button = $("#send-answer");
  if (!input.value.trim()) { input.focus(); return; }
  button.disabled = true;
  try {
    const run = await request(`/runs/${encodeURIComponent(currentRun.id)}/answer`, {
      method: "POST",
      body: jsonBody({ answer: input.value.trim() }),
    });
    renderRun(run?.id ? run : await request(`/runs/${encodeURIComponent(currentRun.id)}`));
    input.value = "";
    setMessage("Answer sent. The run will continue with this detail.", "success");
  } catch (error) {
    setMessage(`Could not send your answer: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function cancelRun() {
  if (!currentRun) return;
  const button = $("#stop-run");
  button.disabled = true;
  try {
    const run = await request(`/runs/${encodeURIComponent(currentRun.id)}/cancel`, { method: "POST" });
    renderRun(run?.id ? run : await request(`/runs/${encodeURIComponent(currentRun.id)}`));
    setMessage("Cancellation requested.", "info");
    await refreshHistory();
  } catch (error) {
    setMessage(`Could not stop this run: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function resetWorkspace() {
  const button = $("#reset-app");
  button.disabled = true;
  try {
    await request("/reset", { method: "POST" });
    currentRun = null;
    runHistory = [];
    lastScreenshotKey = "";
    $("#task-input").value = "";
    $("#inject-failure").checked = true;
    renderRun(null);
    await refreshHistory();
    memoryLoaded = false;
    $("#memory-list").replaceChildren();
    setMessage("Company records were restored to their seeded state. Imported invoices were removed; run history and remembered facts were preserved.", "success");
  } catch (error) {
    setMessage(`Workspace reset was not completed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function pollCurrentRun() {
  if (pollBusy || document.hidden || !currentRun || !activeStatuses.has(currentRun.status)) return;
  pollBusy = true;
  try {
    const run = await request(`/runs/${encodeURIComponent(currentRun.id)}`);
    renderRun(run);
    if (terminalStatuses.has(run.status)) {
      await refreshHistory();
      if (run.status === "completed") setMessage("Run completed. Its result is shown as verified below.", "success");
      else if (run.status === "failed") setMessage(run.error ? `Run failed: ${run.error}` : "Run failed. Review the activity record for details.", "error");
      else setMessage("Run cancelled.", "info");
    }
  } catch (error) {
    setMessage(`Live run update failed: ${error.message}. Retrying automatically.`, "error");
  } finally {
    pollBusy = false;
  }
}

async function loadMemory() {
  const message = $("#memory-message");
  setInlineMessage(message, "Loading remembered facts…", "info");
  try {
    const facts = await request("/memory");
    renderMemory(Array.isArray(facts) ? facts : []);
    memoryLoaded = true;
    setInlineMessage(message, "", "info");
  } catch (error) {
    setInlineMessage(message, `Remembered facts could not be loaded: ${error.message}`, "error");
  }
}

function renderMemory(facts) {
  const list = $("#memory-list");
  list.replaceChildren();
  if (!facts.length) {
    list.append(make("li", "memory-empty", "No facts have been saved yet. A run can add a fact when it is useful for future work."));
    return;
  }
  facts.forEach((fact) => {
    const item = make("li", "memory-item");
    const content = make("div", "");
    content.append(make("p", "memory-fact", fact.fact || "Fact text unavailable"));
    const meta = make("div", "memory-meta");
    if (fact.createdAt) meta.append(make("time", "", formatDate(fact.createdAt, true)));
    meta.append(make("span", "", `Fact ${fact.id || "ID unavailable"}`));
    content.append(meta);
    item.append(content);
    if (fact.runId) {
      const link = make("a", "", "Open run");
      link.href = `/?run=${encodeURIComponent(fact.runId)}`;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        setCurrentView("workspace");
        const url = new URL(window.location.href);
        url.searchParams.set("run", fact.runId);
        window.history.replaceState({}, "", url);
        await loadRun(fact.runId);
      });
      item.append(link);
    }
    list.append(item);
  });
}

function bindEvents() {
  $("#task-form").addEventListener("submit", startRun);
  $("#approve-change").addEventListener("click", () => void respondToApproval(true));
  $("#reject-change").addEventListener("click", () => void respondToApproval(false));
  $("#answer-form").addEventListener("submit", sendAnswer);
  $("#stop-run").addEventListener("click", () => void cancelRun());
  $("#run-history").addEventListener("change", (event) => {
    if (event.currentTarget.value === "__new__") {
      lastScreenshotKey = "";
      renderRun(null);
      setMessage("Ready for a new task.", "info");
    } else void loadRun(event.currentTarget.value);
  });
  $("#reset-app").addEventListener("click", () => $("#reset-dialog").showModal());
  $("#reset-dialog-form").addEventListener("submit", (event) => {
    if (event.submitter?.value === "reset") {
      event.preventDefault();
      $("#reset-dialog").close("reset");
    }
  });
  $("#reset-dialog").addEventListener("close", () => {
    if ($("#reset-dialog").returnValue === "reset") void resetWorkspace();
  });
  $("#refresh-memory").addEventListener("click", () => { memoryLoaded = false; void loadMemory(); });
  document.querySelectorAll("[data-view-button]").forEach((button) => {
    button.addEventListener("click", () => setCurrentView(button.dataset.viewButton));
  });
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#task-input").value = button.dataset.task;
      $("#task-input").focus();
    });
  });
}

async function initialize() {
  const screenshot = make("img", "");
  screenshot.id = "run-screenshot";
  screenshot.alt = "Latest screenshot of the worker's browser";
  screenshot.hidden = true;
  $("#screenshot-frame").prepend(screenshot);
  bindEvents();
  const view = new URLSearchParams(window.location.search).get("view");
  setCurrentView(view === "memory" ? "memory" : "workspace");

  await Promise.all([loadHealth(), refreshHistory()]);
  const requestedRun = new URLSearchParams(window.location.search).get("run");
  const preferred = runHistory.find((run) => run.id === health?.activeRunId)
    || runHistory.find((run) => run.id === requestedRun)
    || runHistory[0];
  if (preferred) await loadRun(preferred.id);
  else renderRun(null);

  if (!health && !runHistory.length) setMessage("The dashboard is ready, but the worker API is not reachable yet. Start the server and refresh to connect.", "error");
  window.setInterval(() => void pollCurrentRun(), 1000);
  window.setInterval(() => void refreshHistory(), 5000);
}

void initialize();
