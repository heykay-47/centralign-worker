const API = "/api";
const $ = (selector, root = document) => root.querySelector(selector);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

let companyState = null;
let activeTab = "inbox";
let selectedMessageId = null;

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

function setNotice(message, tone = "info") {
  const notice = $("#company-notice");
  notice.textContent = message || "";
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

function formatDate(value, includeTime = false) {
  if (!value) return "Not provided";
  const isDateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isDateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  const options = includeTime && !isDateOnly
    ? { dateStyle: "medium", timeStyle: "short" }
    : { year: "numeric", month: "short", day: "numeric", ...(isDateOnly ? { timeZone: "UTC" } : {}) };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatAmount(amount, currency) {
  const code = String(currency || "").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code || "USD" }).format(Number(amount));
  } catch {
    return `${code || ""} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
  }
}

function setActiveTab(tab) {
  activeTab = ["inbox", "accounting", "contacts"].includes(tab) ? tab : "inbox";
  document.querySelectorAll("[data-company-tab]").forEach((link) => {
    if (link.dataset.companyTab === activeTab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function pageHeading(title, description, count) {
  const header = make("div", "company-page-heading");
  const copy = make("div", "");
  copy.append(make("h2", "", title), make("p", "", description));
  header.append(copy);
  if (count !== undefined) header.append(make("span", "records-count", `${count} ${count === 1 ? "record" : "records"}`));
  return header;
}

function fact(label, value, className = "") {
  const wrapper = make("div", className);
  wrapper.append(make("dt", "", label), make("dd", "", value ?? "Not provided"));
  return wrapper;
}

function renderInbox() {
  const content = $("#company-content");
  content.setAttribute("aria-busy", "false");
  const messages = Array.isArray(companyState?.messages)
    ? companyState.messages.slice().sort((a, b) => String(a.receivedAt || "").localeCompare(String(b.receivedAt || "")))
    : [];
  const layout = make("section", "inbox-layout");
  layout.setAttribute("aria-label", "Company inbox");
  const listPanel = make("div", "mail-list-panel");
  const listHeading = make("div", "mail-list-heading");
  listHeading.append(make("h3", "", "Messages"), make("span", "", `${messages.length} · oldest first`));
  listPanel.append(listHeading);
  const list = make("ul", "mail-list");

  if (!messages.length) {
    const empty = make("li", "contacts-empty", "No messages are available in the synthetic inbox.");
    list.append(empty);
  } else {
    const requestedId = new URLSearchParams(window.location.search).get("message");
    if (!selectedMessageId || !messages.some((message) => message.id === selectedMessageId)) {
      selectedMessageId = messages.some((message) => message.id === requestedId) ? requestedId : messages[0].id;
    }
    messages.forEach((message) => {
      const item = make("li", "mail-list-item");
      const button = make("button", "mail-select");
      button.type = "button";
      button.setAttribute("aria-current", String(message.id === selectedMessageId));
      button.append(
        make("span", "mail-from", message.from || "Sender not provided"),
        make("span", "mail-subject", message.subject || "No subject"),
        make("time", "mail-date", formatDate(message.receivedAt, true)),
      );
      button.addEventListener("click", () => {
        selectedMessageId = message.id;
        const url = new URL(window.location.href);
        url.searchParams.set("message", message.id);
        window.history.replaceState({}, "", url);
        renderInbox();
      });
      item.append(button);
      list.append(item);
    });
  }
  listPanel.append(list);

  const reader = make("article", "message-reader");
  const selected = messages.find((message) => message.id === selectedMessageId);
  if (!selected) {
    const empty = make("div", "reader-empty");
    empty.append(make("h3", "", "Select a message to inspect it"), make("p", "", "Email contents and any extracted invoice fields will appear here."));
    reader.append(empty);
  } else {
    const header = make("header", "message-header");
    header.append(
      make("p", "message-sender", selected.from || "Sender not provided"),
      make("h2", "", selected.subject || "No subject"),
      make("time", "message-date", formatDate(selected.receivedAt, true)),
      make("span", "message-id", `Source message ID: ${selected.id}`),
    );
    reader.append(header, make("p", "message-body", selected.body || "This message has no body text."));
    if (selected.invoice) {
      const section = make("section", "invoice-source");
      section.append(make("h3", "", "Invoice details in this message"));
      const dl = make("dl", "invoice-facts");
      const invoice = selected.invoice;
      dl.append(
        fact("Company", invoice.company),
        fact("Invoice number", invoice.invoiceNumber),
        fact("Amount", formatAmount(invoice.amount, invoice.currency)),
        fact("Issued", formatDate(invoice.issuedDate)),
        fact("Due", formatDate(invoice.dueDate)),
        fact("Source message ID", selected.id, "source-fact"),
      );
      section.append(dl);
      reader.append(section);
    }
  }
  layout.append(listPanel, reader);
  content.replaceChildren(pageHeading("Inbox", "Read the original messages and inspect the source details before recording a change.", messages.length), layout);
}

function formField(labelText, name, type = "text", options = {}) {
  const wrapper = make("div", "form-field");
  const inputId = options.id || `field-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const label = make("label", "", labelText);
  label.htmlFor = inputId;
  const input = document.createElement("input");
  input.id = inputId;
  input.name = name;
  input.type = type;
  if (options.required) input.required = true;
  if (options.value !== undefined) input.value = options.value;
  if (options.min !== undefined) input.min = options.min;
  if (options.step !== undefined) input.step = options.step;
  if (options.maxLength !== undefined) input.maxLength = options.maxLength;
  if (options.pattern !== undefined) input.pattern = options.pattern;
  if (options.autocomplete !== undefined) input.autocomplete = options.autocomplete;
  if (options.placeholder) input.placeholder = options.placeholder;
  wrapper.append(label, input);
  return { wrapper, input };
}

function renderInvoices() {
  const content = $("#company-content");
  content.setAttribute("aria-busy", "false");
  const invoices = Array.isArray(companyState?.invoices) ? companyState.invoices : [];
  const layout = make("div", "accounting-layout");
  const tableWrap = make("section", "accounting-table-wrap");
  const heading = make("div", "section-heading");
  heading.append(make("h3", "", "Saved invoices"), make("span", "", `${invoices.length} saved`));
  const scroll = make("div", "invoice-table-scroll");
  const table = make("table", "invoice-table");
  const caption = make("caption", "visually-hidden", "Invoices saved in the company accounting workspace");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Company", "Invoice", "Amount", "Due date", "Source"].forEach((label) => headRow.append(make("th", "", label)));
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  if (!invoices.length) {
    const row = make("tr", "empty-row");
    const cell = make("td", "", "No invoices have been saved yet.");
    cell.colSpan = 5;
    row.append(cell);
    tbody.append(row);
  } else {
    invoices.forEach((invoice) => {
      const row = document.createElement("tr");
      row.append(
        make("td", "", invoice.company || "Not provided"),
        make("td", "", invoice.invoiceNumber || "Not provided"),
        make("td", "amount", formatAmount(invoice.amount, invoice.currency)),
        make("td", "", formatDate(invoice.dueDate)),
      );
      const sourceCell = document.createElement("td");
      if (invoice.sourceMessageId) {
        const link = make("a", "", invoice.sourceMessageId);
        link.href = `/company?tab=inbox&message=${encodeURIComponent(invoice.sourceMessageId)}`;
        sourceCell.append(link);
      } else sourceCell.textContent = "Not provided";
      row.append(sourceCell);
      tbody.append(row);
    });
  }
  table.append(caption, thead, tbody);
  scroll.append(table);
  tableWrap.append(heading, scroll);

  const entry = make("section", "entry-panel");
  const entryHeading = make("div", "section-heading");
  entryHeading.append(make("h3", "", "Add an invoice"));
  const form = make("form", "invoice-form");
  form.id = "invoice-form";
  const fields = [
    formField("Company", "company", "text", { required: true, maxLength: 160, autocomplete: "organization" }),
    formField("Invoice number", "invoiceNumber", "text", { required: true, maxLength: 80 }),
    formField("Amount", "amount", "number", { required: true, min: "0.01", step: "0.01" }),
    formField("Currency", "currency", "text", { required: true, value: "USD", maxLength: 3, pattern: "[A-Za-z]{3}" }),
    formField("Issued date", "issuedDate", "date", { required: true }),
    formField("Due date", "dueDate", "date", { required: true }),
    formField("Source message ID", "sourceMessageId", "text", { required: true, maxLength: 120 }),
  ];
  fields.forEach(({ wrapper }) => form.append(wrapper));
  const hint = make("p", "form-hint", "Use the source message ID shown in the inbox to keep the record traceable.");
  const submit = make("button", "company-button company-button-primary", "Save invoice");
  submit.type = "submit";
  submit.dataset.write = "true";
  form.append(hint, submit);
  const feedback = make("p", "form-feedback");
  feedback.id = "invoice-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  entry.append(entryHeading, form, feedback);
  layout.append(tableWrap, entry);
  content.replaceChildren(pageHeading("Accounting", "Review saved records or enter invoice details from a source message.", invoices.length), layout);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector("[type=submit]");
    const data = new FormData(form);
    const payload = {
      company: String(data.get("company")).trim(),
      invoiceNumber: String(data.get("invoiceNumber")).trim(),
      amount: Number(data.get("amount")),
      currency: String(data.get("currency")).trim().toUpperCase(),
      issuedDate: String(data.get("issuedDate")),
      dueDate: String(data.get("dueDate")),
      sourceMessageId: String(data.get("sourceMessageId")).trim(),
    };
    button.disabled = true;
    feedback.classList.remove("is-error");
    feedback.textContent = "Saving invoice…";
    try {
      await request("/company/invoices", { method: "POST", body: JSON.stringify(payload) });
      await refreshCompany({ announce: false });
      const savedRecordVisible = companyState?.invoices?.some((invoice) =>
        invoice.invoiceNumber === payload.invoiceNumber && invoice.sourceMessageId === payload.sourceMessageId,
      );
      const currentFeedback = $("#invoice-feedback");
      if (currentFeedback) {
        currentFeedback.classList.toggle("is-error", !savedRecordVisible);
        currentFeedback.textContent = savedRecordVisible
          ? "Invoice saved. The updated record is shown in the table."
          : "Invoice saved, but the table could not be refreshed. Use Refresh data to verify the latest records.";
      }
      setNotice(
        savedRecordVisible ? "Invoice record saved and visible in the company table." : "Invoice saved, but the table could not be refreshed. Use Refresh data to verify the latest records.",
        savedRecordVisible ? "success" : "error",
      );
    } catch (error) {
      feedback.classList.add("is-error");
      feedback.textContent = `Invoice was not saved: ${error.message}. Check the fields and retry.`;
    } finally {
      button.disabled = false;
    }
  });
}

function renderContacts() {
  const content = $("#company-content");
  content.setAttribute("aria-busy", "false");
  const contacts = Array.isArray(companyState?.contacts) ? companyState.contacts : [];
  const list = make("section", "contacts-list");
  list.setAttribute("aria-label", "Company contacts");
  if (!contacts.length) {
    list.append(make("p", "contacts-empty", "No contacts are available in the synthetic workspace."));
  } else {
    contacts.forEach((contact, index) => {
      const row = make("article", "contact-row");
      const identity = make("div", "contact-identity");
      identity.append(
        make("p", "contact-company", contact.company || "Company not provided"),
        make("p", "contact-name", contact.name || "Name not provided"),
      );
      if (contact.phone) identity.append(make("p", "contact-phone", contact.phone));
      const form = make("form", "contact-form");
      const nameField = formField("Contact name", "name", "text", { required: true, maxLength: 160, value: contact.name || "", id: `contact-${index}-name` });
      const emailField = formField("Email address", "email", "email", { required: true, maxLength: 320, value: contact.email || "", id: `contact-${index}-email` });
      const phoneField = formField("Phone", "phone", "text", { maxLength: 60, value: contact.phone || "", id: `contact-${index}-phone` });
      form.append(nameField.wrapper, emailField.wrapper, phoneField.wrapper);
      const button = make("button", "company-button company-button-secondary", "Save contact");
      button.type = "submit";
      button.dataset.write = "true";
      form.append(button);
      const feedback = make("p", "form-feedback");
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      row.append(identity, form, feedback);
      list.append(row);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const submitted = new FormData(form);
        const next = {
          name: String(submitted.get("name")).trim(),
          email: String(submitted.get("email")).trim(),
          phone: String(submitted.get("phone")).trim(),
        };
        const patch = {};
        if (next.name !== (contact.name || "")) patch.name = next.name;
        if (next.email !== (contact.email || "")) patch.email = next.email;
        if (next.phone !== (contact.phone || "")) patch.phone = next.phone;
        if (!Object.keys(patch).length) {
          feedback.classList.remove("is-error");
          feedback.textContent = "No contact fields have changed.";
          return;
        }
        button.disabled = true;
        feedback.classList.remove("is-error");
        feedback.textContent = "Saving contact…";
        try {
          await request(`/company/contacts/${encodeURIComponent(contact.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
          await refreshCompany({ announce: false });
          setNotice("Contact details saved to the company workspace.", "success");
        } catch (error) {
          feedback.classList.add("is-error");
          feedback.textContent = `Contact was not saved: ${error.message}. Check the fields and retry.`;
          button.disabled = false;
        }
      });
    });
  }
  content.replaceChildren(pageHeading("Contacts", "Review the current contact details. Changes are saved to the company record.", contacts.length), list);
}

function render() {
  if (!companyState) return;
  if (activeTab === "accounting") renderInvoices();
  else if (activeTab === "contacts") renderContacts();
  else renderInbox();
}

async function refreshCompany({ announce = true } = {}) {
  const button = $("#refresh-company");
  if (announce) button.disabled = true;
  try {
    companyState = await request("/company/state");
    render();
    setNotice(announce ? "Company data refreshed from the server." : "", "success");
  } catch (error) {
    $("#company-content").setAttribute("aria-busy", "false");
    if (!companyState) {
      const errorPanel = make("div", "company-loading", `Company data could not be loaded: ${error.message}`);
      $("#company-content").replaceChildren(errorPanel);
    }
    setNotice(`Could not load company records: ${error.message}. Use Refresh data to retry.`, "error");
  } finally {
    if (announce) button.disabled = false;
  }
}

function initialize() {
  const query = new URLSearchParams(window.location.search);
  setActiveTab(query.get("tab") || "inbox");
  selectedMessageId = query.get("message");
  $("#refresh-company").addEventListener("click", () => void refreshCompany());
  void refreshCompany({ announce: false });
}

initialize();
