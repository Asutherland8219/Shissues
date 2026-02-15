(() => {
  const status = document.getElementById("status");

  let vscodeApi = null;
  try {
    vscodeApi = acquireVsCodeApi();
  } catch (error) {
    if (status) {
      status.textContent = "Failed to acquire VS Code API";
    }
    console.error(error);
  }

  function post(type, payload = {}) {
    if (!vscodeApi) {
      return;
    }
    vscodeApi.postMessage({ type, ...payload });
  }

  const repoLabel = document.getElementById("repoLabel");
  const repoSelect = document.getElementById("repoSelect");
  const summaryLabel = document.getElementById("summaryLabel");
  const issueList = document.getElementById("issueList");
  const searchInput = document.getElementById("searchInput");
  const searchButton = document.getElementById("searchButton");
  const clearButton = document.getElementById("clearButton");
  const filterSelect = document.getElementById("filterSelect");
  const refreshButton = document.getElementById("refreshButton");
  const newIssueButton = document.getElementById("newIssueButton");
  const editor = document.getElementById("editor");
  const editorTitle = document.getElementById("editorTitle");
  const editorClose = document.getElementById("editorClose");
  const issueTitle = document.getElementById("issueTitle");
  const issueBody = document.getElementById("issueBody");
  const attachImageButton = document.getElementById("attachImageButton");
  const imageInput = document.getElementById("imageInput");
  const imageStatus = document.getElementById("imageStatus");
  const imageHelp = document.getElementById("imageHelp");
  const labelsDropdown = document.getElementById("labelsDropdown");
  const assigneesDropdown = document.getElementById("assigneesDropdown");
  const labelsList = document.getElementById("labelsList");
  const assigneesList = document.getElementById("assigneesList");
  const saveIssueButton = document.getElementById("saveIssueButton");
  const cancelIssueButton = document.getElementById("cancelIssueButton");

  let editorMode = "create";
  let editorNumber = null;
  let meta = { labels: [], assignees: [], loaded: false };
  let pendingSelection = { labels: [], assignees: [] };
  let currentRepo = "";
  const imageMaxMb = Number(document.body.dataset.imageMaxMb || 10);
  const imageMaxBytes = Number(
    document.body.dataset.imageMaxBytes || Math.round(imageMaxMb * 1024 * 1024)
  );
  const pendingUploads = new Map();

  if (imageHelp) {
    imageHelp.textContent = "Paste an image or upload (max " + imageMaxMb + " MB).";
  }

  window.addEventListener("error", (event) => {
    const message = event?.message || "Unknown webview error";
    if (status) {
      status.textContent = "Webview error: " + message;
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const message = reason instanceof Error ? reason.message : String(reason || "Unhandled rejection");
    if (status) {
      status.textContent = "Webview error: " + message;
    }
  });

  function render(payload) {
    currentRepo = payload.repo || "";
    repoLabel.textContent = payload.repo ? "Repo: " + payload.repo : "Repo: —";
    renderRepoSelect(payload);
    summaryLabel.textContent = payload.search
      ? 'Search: "' + payload.search + '"'
      : payload.filter
        ? "Filter: " + payload.filter
        : "";
    searchInput.value = payload.search || "";
    filterSelect.value = payload.filter || "open";
    issueList.innerHTML = "";
    refreshButton.classList.remove("spinning");

    if (payload.status === "noRepo") {
      status.textContent = "No repository configured.";
      issueList.appendChild(buildEmpty("Set a repo to load issues.", "Init Repo", "initRepo"));
      return;
    }

    if (payload.status === "noAuth") {
      status.textContent = payload.error || "Authentication required.";
      const container = document.createElement("div");
      container.className = "empty";
      container.textContent = "Configure auth to load issues.";
      const actions = document.createElement("div");
      actions.className = "issue-actions";
      actions.appendChild(buildAction("Set Auth Mode", "setAuthMode"));
      actions.appendChild(buildAction("Set PAT", "setPat"));
      container.appendChild(actions);
      issueList.appendChild(container);
      return;
    }

    if (payload.status === "error") {
      status.textContent = payload.error || "Failed to load issues.";
      issueList.appendChild(buildEmpty("Try refreshing the view.", "Refresh", "refresh"));
      return;
    }

    status.textContent = payload.issues.length ? payload.issues.length + " issue(s)" : "No issues found.";

    if (!payload.issues.length) {
      issueList.appendChild(buildEmpty("No issues match this view.", "Clear Search", "clearSearch"));
      return;
    }

    payload.issues.forEach((issue) => {
      issueList.appendChild(buildIssue(issue));
    });
  }

  function renderRepoSelect(payload) {
    if (!repoSelect) {
      return;
    }
    const shouldShow = !payload.repo;
    repoSelect.style.display = shouldShow ? "inline-flex" : "none";
    if (!shouldShow) {
      return;
    }
    const repos = Array.isArray(payload.repoCandidates) ? payload.repoCandidates : [];
    repoSelect.innerHTML = "";
    const autoOption = document.createElement("option");
    autoOption.value = "__auto__";
    autoOption.textContent = "Auto-detect repo";
    repoSelect.appendChild(autoOption);

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = repos.length ? "Select repo..." : "No repos detected";
    placeholder.disabled = true;
    repoSelect.appendChild(placeholder);

    repos.forEach((repo) => {
      const option = document.createElement("option");
      option.value = repo;
      option.textContent = repo;
      repoSelect.appendChild(option);
    });

    const customOption = document.createElement("option");
    customOption.value = "__custom__";
    customOption.textContent = "Enter owner/repo...";
    repoSelect.appendChild(customOption);

    if (payload.repo) {
      repoSelect.value = payload.repo;
    } else {
      repoSelect.value = "__auto__";
    }
  }

  function applyMeta(newMeta) {
    if (!newMeta) {
      return;
    }
    meta = {
      labels: Array.isArray(newMeta.labels) ? newMeta.labels : [],
      assignees: Array.isArray(newMeta.assignees) ? newMeta.assignees : [],
      repo: newMeta.repo || "",
      loaded: true
    };
    renderMetaLists();
  }

  function buildEmpty(text, buttonLabel, action) {
    const container = document.createElement("div");
    container.className = "empty";
    const label = document.createElement("div");
    label.textContent = text;
    container.appendChild(label);
    if (buttonLabel && action) {
      const actionButton = document.createElement("button");
      actionButton.textContent = buttonLabel;
      actionButton.className = "secondary";
      actionButton.addEventListener("click", () => post(action));
      container.appendChild(actionButton);
    }
    return container;
  }

  function buildAction(label, action, extra = {}) {
    const button = document.createElement("button");
    button.textContent = label;
    button.className = "secondary";
    button.addEventListener("click", () => post(action, extra));
    return button;
  }

  function buildIssue(issue) {
    const card = document.createElement("div");
    card.className = "issue";

    const title = document.createElement("div");
    title.className = "issue-title";
    title.textContent = "#" + issue.number + " " + issue.title;
    card.appendChild(title);

    const metaBlock = document.createElement("div");
    metaBlock.className = "issue-meta";
    metaBlock.textContent =
      (issue.state || "unknown") +
      " • @" +
      (issue.user || "unknown") +
      " • updated " +
      (issue.updatedAt || "unknown");
    card.appendChild(metaBlock);

    if (issue.assignees && issue.assignees.length) {
      const assignees = document.createElement("div");
      assignees.className = "issue-meta";
      assignees.textContent = "Assignees: " + issue.assignees.join(", ");
      card.appendChild(assignees);
    }

    if (issue.labels && issue.labels.length) {
      const labels = document.createElement("div");
      labels.className = "labels";
      issue.labels.forEach((label) => {
        const pill = document.createElement("span");
        pill.className = "label";
        pill.textContent = label;
        labels.appendChild(pill);
      });
      card.appendChild(labels);
    }

    const actions = document.createElement("div");
    actions.className = "issue-actions";
    actions.appendChild(buildAction("Open", "openIssue", { url: issue.htmlUrl }));
    actions.appendChild(buildAction("Summary", "summaryIssue", { number: issue.number }));
    actions.appendChild(buildAction("Copy URL", "copyIssue", { url: issue.htmlUrl }));
    actions.appendChild(buildAction("Edit", "loadIssueForEdit", { number: issue.number }));
    if (issue.state === "open") {
      actions.appendChild(buildAction("Close", "setIssueState", { number: issue.number, state: "closed" }));
    } else {
      actions.appendChild(buildAction("Reopen", "setIssueState", { number: issue.number, state: "open" }));
    }
    card.appendChild(actions);

    return card;
  }

  function updateDropdownSummary(dropdown, label, selected) {
    const summary = dropdown.querySelector("summary");
    if (!summary) {
      return;
    }
    if (!selected.length) {
      summary.textContent = "Select " + label.toLowerCase();
      return;
    }
    const preview = selected.join(", ");
    summary.textContent = preview;
  }

  function renderCheckboxList(container, items, selectedValues) {
    container.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No options available.";
      container.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const label = document.createElement("label");
      label.className = "checkbox-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = item;
      input.checked = selectedValues.has(item);
      label.appendChild(input);
      const text = document.createElement("span");
      text.textContent = item;
      label.appendChild(text);
      container.appendChild(label);
    });
  }

  function renderMetaLists() {
    const selectedLabels = new Set(pendingSelection.labels || []);
    const selectedAssignees = new Set(pendingSelection.assignees || []);
    renderCheckboxList(labelsList, meta.labels || [], selectedLabels);
    renderCheckboxList(assigneesList, meta.assignees || [], selectedAssignees);
    updateDropdownSummary(labelsDropdown, "Labels", Array.from(selectedLabels));
    updateDropdownSummary(assigneesDropdown, "Assignees", Array.from(selectedAssignees));
  }

  function getCheckedValues(container) {
    return Array.from(container.querySelectorAll("input[type='checkbox']:checked")).map(
      (input) => input.value
    );
  }

  function setImageStatus(text) {
    if (!imageStatus) {
      return;
    }
    imageStatus.textContent = text || "";
  }

  function insertAtCursor(textarea, text) {
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const nextPos = start + text.length;
    textarea.selectionStart = nextPos;
    textarea.selectionEnd = nextPos;
    textarea.focus();
  }

  function createRequestId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function uploadImageFile(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      setImageStatus("Only image files can be uploaded.");
      return;
    }
    if (imageMaxBytes && file.size > imageMaxBytes) {
      setImageStatus("Image exceeds " + imageMaxMb + " MB limit.");
      return;
    }
    const requestId = createRequestId();
    const displayName = file.name || "pasted-image";
    pendingUploads.set(requestId, displayName);
    setImageStatus("Uploading " + displayName + "...");
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      post("uploadImage", {
        requestId,
        name: file.name || "",
        mime: file.type || "",
        size: file.size || 0,
        data: base64 || ""
      });
    };
    reader.onerror = () => {
      pendingUploads.delete(requestId);
      setImageStatus("Failed to read " + displayName + ".");
    };
    reader.readAsDataURL(file);
  }

  function openEditor(mode, issue) {
    editorMode = mode;
    editorNumber = issue ? issue.number : null;
    editorTitle.textContent = mode === "edit" ? "Edit Issue" : "New Issue";
    saveIssueButton.textContent = mode === "edit" ? "Update Issue" : "Create Issue";
    issueTitle.value = issue ? issue.title || "" : "";
    issueBody.value = issue ? issue.body || "" : "";
    pendingSelection = {
      labels: issue && issue.labels ? issue.labels : [],
      assignees: issue && issue.assignees ? issue.assignees : []
    };
    renderMetaLists();
    if (!meta.loaded || (meta.repo && meta.repo !== currentRepo)) {
      post("requestMeta");
    }
    editor.classList.add("visible");
  }

  function closeEditor() {
    editor.classList.remove("visible");
    editorMode = "create";
    editorNumber = null;
    issueTitle.value = "";
    issueBody.value = "";
    pendingSelection = { labels: [], assignees: [] };
    pendingUploads.clear();
    setImageStatus("");
    renderMetaLists();
  }

  searchButton.addEventListener("click", () => post("search", { value: searchInput.value }));
  clearButton.addEventListener("click", () => post("clearSearch"));
  if (repoSelect) {
    repoSelect.addEventListener("change", () => {
      const value = repoSelect.value;
      if (!value || value === "__placeholder__") {
        return;
      }
      post("setRepo", { value });
    });
  }
  refreshButton.addEventListener("click", () => {
    refreshButton.classList.add("spinning");
    post("refresh");
  });
  newIssueButton.addEventListener("click", () => openEditor("create"));
  editorClose.addEventListener("click", () => closeEditor());
  cancelIssueButton.addEventListener("click", () => closeEditor());
  if (attachImageButton && imageInput) {
    attachImageButton.addEventListener("click", () => imageInput.click());
    imageInput.addEventListener("change", () => {
      const files = Array.from(imageInput.files || []);
      files.forEach(uploadImageFile);
      imageInput.value = "";
    });
  }
  issueBody.addEventListener("paste", (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const images = items.filter((item) => item.type && item.type.startsWith("image/"));
    if (!images.length) {
      return;
    }
    const types = Array.from(event.clipboardData?.types || []);
    const hasText = types.includes("text/plain");
    if (!hasText) {
      event.preventDefault();
    }
    images.forEach((item) => {
      const file = item.getAsFile();
      if (file) {
        uploadImageFile(file);
      }
    });
  });
  labelsList.addEventListener("change", () =>
    (() => {
      const selected = getCheckedValues(labelsList);
      pendingSelection.labels = selected;
      updateDropdownSummary(labelsDropdown, "Labels", selected);
    })()
  );
  assigneesList.addEventListener("change", () =>
    (() => {
      const selected = getCheckedValues(assigneesList);
      pendingSelection.assignees = selected;
      updateDropdownSummary(assigneesDropdown, "Assignees", selected);
    })()
  );
  saveIssueButton.addEventListener("click", () => {
    const payload = {
      title: issueTitle.value,
      body: issueBody.value,
      labels: getCheckedValues(labelsList),
      assignees: getCheckedValues(assigneesList)
    };
    if (editorMode === "edit" && editorNumber) {
      post("updateIssue", { number: editorNumber, ...payload });
    } else {
      post("createIssue", payload);
    }
  });
  filterSelect.addEventListener("change", () => post("setFilter", { value: filterSelect.value }));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      post("search", { value: searchInput.value });
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "render") {
      render(message.payload);
      refreshButton.classList.remove("spinning");
    }
    if (message.type === "editData") {
      if (message.payload) {
        if (message.payload.meta) {
          applyMeta(message.payload.meta);
        }
        if (message.payload.issue) {
          openEditor("edit", message.payload.issue);
        }
      }
    }
    if (message.type === "meta") {
      applyMeta(message.payload);
    }
    if (message.type === "issueSaved") {
      closeEditor();
    }
    if (message.type === "imageUploaded") {
      const payload = message.payload || {};
      const markdown = payload.markdown || "";
      if (markdown) {
        const cursor = issueBody.selectionStart ?? issueBody.value.length;
        const prefix = issueBody.value.slice(0, cursor);
        const needsNewline = prefix && !prefix.endsWith("\n");
        const insertText = (needsNewline ? "\n" : "") + markdown + "\n";
        insertAtCursor(issueBody, insertText);
      }
      const label = pendingUploads.get(payload.requestId) || "image";
      pendingUploads.delete(payload.requestId);
      setImageStatus("Inserted " + label + ".");
    }
    if (message.type === "imageUploadError") {
      const payload = message.payload || {};
      const label = pendingUploads.get(payload.requestId) || "image";
      pendingUploads.delete(payload.requestId);
      const reason = payload.message || "Unknown error";
      setImageStatus("Upload failed for " + label + ": " + reason);
    }
    if (message.type === "error") {
      refreshButton.classList.remove("spinning");
    }
  });

  post("ready");
})();
