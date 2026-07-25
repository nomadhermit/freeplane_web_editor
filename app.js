(() => {
  "use strict";

  // ---------- state ----------
  let maps = [];                 // list of map names
  let currentName = null;        // currently open map name
  let mapData = null;            // { version, root }
  let selectedId = null;
  let dirty = false;

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const mapSelect = $("#map-select");
  const btnNew = $("#btn-new");
  const btnUpload = $("#btn-upload");
  const fileUpload = $("#file-upload");
  const btnSave = $("#btn-save");
  const btnDownload = $("#btn-download");
  const btnDeleteMap = $("#btn-delete-map");
  const btnAddChild = $("#btn-add-child");
  const btnAddSibling = $("#btn-add-sibling");
  const btnMoveUp = $("#btn-move-up");
  const btnMoveDown = $("#btn-move-down");
  const btnSortChildren = $("#btn-sort-children");
  const btnDeleteNode = $("#btn-delete-node");
  const treeEl = $("#tree");
  const editorEl = $("#editor");
  const statusEl = $("#status");

  // ---------- helpers ----------
  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
    if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 4000);
  }

  function setDirty(v) {
    dirty = v;
    btnSave.disabled = !currentName || !dirty;
    document.title = (dirty ? "• " : "") + (currentName || "Freeplane Web Editor");
  }

  function newId() {
    return "ID_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function findNode(node, id, parent = null) {
    if (node.id === id) return { node, parent };
    for (const c of node.children || []) {
      const r = findNode(c, id, node);
      if (r) return r;
    }
    return null;
  }

  function collectIds(node, set = new Set()) {
    set.add(node.id);
    (node.children || []).forEach(c => collectIds(c, set));
    return set;
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function refreshMapList() {
    maps = await api("GET", "/api/maps");
    mapSelect.innerHTML = '<option value="">— Open map —</option>';
    maps.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === currentName) opt.selected = true;
      mapSelect.appendChild(opt);
    });
  }

  async function openMap(name) {
    if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
    const data = await api("GET", `/api/map/${encodeURIComponent(name)}`);
    currentName = name;
    mapData = data;
    selectedId = data.root.id;
    setDirty(false);
    renderTree();
    renderEditor();
    updateToolbar();
    setStatus(`Opened “${name}”`);
  }

  async function saveMap() {
    if (!currentName || !mapData) return;
    await api("PUT", `/api/map/${encodeURIComponent(currentName)}`, mapData);
    setDirty(false);
    setStatus("Saved");
  }

  async function createNewMap() {
    if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
    const name = prompt("Name for the new mind map:");
    if (!name || !name.trim()) return;
    try {
      const data = await api("POST", "/api/maps", { name: name.trim() });
      currentName = name.trim();
      mapData = data;
      selectedId = data.root.id;
      setDirty(false);
      await refreshMapList();
      renderTree();
      renderEditor();
      updateToolbar();
      setStatus(`Created “${currentName}”`);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function uploadMap(file) {
    if (!file) return;
    if (dirty && !confirm("You have unsaved changes. Discard them?")) {
      fileUpload.value = "";
      return;
    }

    const form = new FormData();
    form.append("file", file);

    // Try without overwrite first; on 409 ask user
    let res = await fetch("/api/upload", { method: "POST", body: form });
    if (res.status === 409) {
      if (!confirm(`A map named “${file.name.replace(/\.mm$/i, "")}” already exists. Overwrite it?`)) {
        fileUpload.value = "";
        return;
      }
      form.append("overwrite", "1");
      res = await fetch("/api/upload", { method: "POST", body: form });
    }

    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }

    const result = await res.json();
    currentName = result.name;
    mapData = result.map;
    selectedId = mapData.root.id;
    setDirty(false);
    await refreshMapList();
    renderTree();
    renderEditor();
    updateToolbar();
    setStatus(`Uploaded “${currentName}”`);
    fileUpload.value = "";
  }

  async function deleteCurrentMap() {
    if (!currentName) return;
    if (!confirm(`Delete map “${currentName}” permanently?`)) return;
    await api("DELETE", `/api/map/${encodeURIComponent(currentName)}`);
    currentName = null;
    mapData = null;
    selectedId = null;
    setDirty(false);
    await refreshMapList();
    renderTree();
    renderEditor();
    updateToolbar();
    setStatus("Map deleted");
  }

  // ---------- rendering ----------
  function renderTree() {
    treeEl.innerHTML = "";
    if (!mapData) {
      treeEl.innerHTML = '<p style="color:var(--muted);padding:1rem">No map open</p>';
      return;
    }
    treeEl.appendChild(buildTreeNode(mapData.root, 0));
  }

  function buildTreeNode(node, depth) {
    const hasChildren = node.children && node.children.length > 0;
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node";
    wrapper.dataset.id = node.id;

    const row = document.createElement("div");
    row.className = "tree-node-row" + (node.id === selectedId ? " selected" : "");
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      selectNode(node.id);
    });

    const toggle = document.createElement("span");
    toggle.className = "toggle" + (hasChildren ? "" : " empty");
    toggle.textContent = node._collapsed ? "▶" : "▼";
    if (hasChildren) {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        node._collapsed = !node._collapsed;
        renderTree();
      });
    }

    const label = document.createElement("span");
    label.className = "node-label" + (node.note ? " has-note" : "");
    label.textContent = node.text || "(empty)";
    label.title = node.text;

    row.appendChild(toggle);
    row.appendChild(label);
    wrapper.appendChild(row);

    if (hasChildren && !node._collapsed) {
      const kids = document.createElement("div");
      kids.className = "children";
      node.children.forEach(c => kids.appendChild(buildTreeNode(c, depth + 1)));
      wrapper.appendChild(kids);
    }
    return wrapper;
  }

  function selectNode(id) {
    selectedId = id;
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function renderEditor() {
    if (!mapData || !selectedId) {
      editorEl.className = "empty";
      editorEl.innerHTML = "<p>Select a node to edit its text and note.</p>";
      return;
    }
    const found = findNode(mapData.root, selectedId);
    if (!found) {
      editorEl.className = "empty";
      editorEl.innerHTML = "<p>Node not found</p>";
      return;
    }
    const node = found.node;
    editorEl.className = "";
    editorEl.innerHTML = `
      <div class="field">
        <label for="node-text">Node Text</label>
        <input type="text" id="node-text" value="${escapeAttr(node.text)}" />
      </div>
      <div class="field">
        <label for="node-note">Note</label>
        <textarea id="node-note" rows="8" placeholder="Optional note for this node…">${escapeHtml(node.note || "")}</textarea>
      </div>
      <div class="meta">
        ID: <code>${escapeHtml(node.id)}</code>
        &nbsp;·&nbsp; Children: ${node.children ? node.children.length : 0}
      </div>
    `;

    const textInput = $("#node-text");
    const noteInput = $("#node-note");

    textInput.addEventListener("input", () => {
      node.text = textInput.value;
      setDirty(true);
      // update label in tree without full re-render for snappiness
      const row = treeEl.querySelector(`[data-id="${node.id}"] > .tree-node-row .node-label`);
      if (row) {
        row.textContent = node.text || "(empty)";
        row.classList.toggle("has-note", !!node.note);
      }
    });

    noteInput.addEventListener("input", () => {
      node.note = noteInput.value;
      setDirty(true);
      const row = treeEl.querySelector(`[data-id="${node.id}"] > .tree-node-row .node-label`);
      if (row) row.classList.toggle("has-note", !!node.note);
    });

    textInput.focus();
    textInput.select();
  }

  function updateToolbar() {
    const hasMap = !!currentName;
    btnSave.disabled = !hasMap || !dirty;
    btnDownload.disabled = !hasMap;
    btnDeleteMap.disabled = !hasMap;
    btnAddChild.disabled = !selectedId;

    const found = selectedId && mapData ? findNode(mapData.root, selectedId) : null;
    const isRoot = !!(mapData && selectedId === mapData.root.id);
    const parent = found && found.parent;
    const siblings = parent ? parent.children : null;
    const idx = siblings ? siblings.indexOf(found.node) : -1;

    btnAddSibling.disabled = !selectedId || isRoot;
    btnDeleteNode.disabled = !selectedId || isRoot;
    btnMoveUp.disabled = !siblings || idx <= 0;
    btnMoveDown.disabled = !siblings || idx < 0 || idx >= siblings.length - 1;
    btnSortChildren.disabled = !found || !found.node.children || found.node.children.length < 2;
  }

  // ---------- CRUD operations ----------
  function addChild() {
    if (!selectedId || !mapData) return;
    const found = findNode(mapData.root, selectedId);
    if (!found) return;
    const child = {
      id: newId(),
      text: "New node",
      note: "",
      folded: false,
      children: []
    };
    if (!found.node.children) found.node.children = [];
    found.node.children.push(child);
    selectedId = child.id;
    setDirty(true);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function addSibling() {
    if (!selectedId || !mapData) return;
    const found = findNode(mapData.root, selectedId);
    if (!found || !found.parent) return; // root has no sibling
    const sibling = {
      id: newId(),
      text: "New node",
      note: "",
      folded: false,
      children: []
    };
    const idx = found.parent.children.indexOf(found.node);
    found.parent.children.splice(idx + 1, 0, sibling);
    selectedId = sibling.id;
    setDirty(true);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function deleteNode() {
    if (!selectedId || !mapData) return;
    if (selectedId === mapData.root.id) {
      alert("Cannot delete the root node.");
      return;
    }
    const found = findNode(mapData.root, selectedId);
    if (!found || !found.parent) return;
    if (!confirm("Delete this node and all its children?")) return;
    const idx = found.parent.children.indexOf(found.node);
    found.parent.children.splice(idx, 1);
    selectedId = found.parent.id;
    setDirty(true);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function moveNode(direction) {
    if (!selectedId || !mapData) return;
    const found = findNode(mapData.root, selectedId);
    if (!found || !found.parent) return;
    const siblings = found.parent.children;
    const idx = siblings.indexOf(found.node);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= siblings.length) return;
    // swap
    siblings[idx] = siblings[newIdx];
    siblings[newIdx] = found.node;
    setDirty(true);
    renderTree();
    updateToolbar();
  }

  function sortChildren() {
    if (!selectedId || !mapData) return;
    const found = findNode(mapData.root, selectedId);
    if (!found || !found.node.children || found.node.children.length < 2) return;
    found.node.children.sort((a, b) =>
      (a.text || "").localeCompare(b.text || "", undefined, { sensitivity: "base" })
    );
    setDirty(true);
    renderTree();
    updateToolbar();
    setStatus("Children sorted A–Z");
  }

  // ---------- utils ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  // ---------- events ----------
  btnNew.addEventListener("click", () => createNewMap().catch(e => setStatus(e.message, true)));
  btnUpload.addEventListener("click", () => fileUpload.click());
  fileUpload.addEventListener("change", () => {
    const file = fileUpload.files && fileUpload.files[0];
    if (file) uploadMap(file).catch(e => setStatus(e.message, true));
  });
  btnSave.addEventListener("click", () => saveMap().catch(e => setStatus(e.message, true)));
  btnDownload.addEventListener("click", () => {
    if (currentName) window.location.href = `/api/download/${encodeURIComponent(currentName)}`;
  });
  btnDeleteMap.addEventListener("click", () => deleteCurrentMap().catch(e => setStatus(e.message, true)));
  btnAddChild.addEventListener("click", addChild);
  btnAddSibling.addEventListener("click", addSibling);
  btnMoveUp.addEventListener("click", () => moveNode(-1));
  btnMoveDown.addEventListener("click", () => moveNode(1));
  btnSortChildren.addEventListener("click", sortChildren);
  btnDeleteNode.addEventListener("click", deleteNode);

  mapSelect.addEventListener("change", () => {
    const name = mapSelect.value;
    if (name) openMap(name).catch(e => setStatus(e.message, true));
  });

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "s") {
        e.preventDefault();
        if (!btnSave.disabled) saveMap().catch(err => setStatus(err.message, true));
      }
    }
    // Alt+↑ / Alt+↓ move among siblings (ignore when typing in inputs)
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!btnMoveUp.disabled) moveNode(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!btnMoveDown.disabled) moveNode(1);
      }
    }
  });

  // ---------- init ----------
  refreshMapList().catch(e => setStatus(e.message, true));
  updateToolbar();
})();
