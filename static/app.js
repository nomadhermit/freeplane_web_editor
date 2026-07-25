(() => {
  "use strict";

  // ---------- state ----------
  let maps = [];                 // list of map names
  let currentName = null;        // currently open map name
  let mapData = null;            // { version, root }
  let selectedId = null;
  let dirty = false;
  let linkMode = false;          // when true, next node click creates a link
  let reparentMode = false;      // when true, next node click becomes the new parent

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
  const btnLink = $("#btn-link");
  const btnReparent = $("#btn-reparent");
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

  /** Walk entire tree and call fn(node) for every node. */
  function walkNodes(node, fn) {
    if (!node) return;
    fn(node);
    (node.children || []).forEach(c => walkNodes(c, fn));
  }

  /** Ensure node.links is always an array. */
  function ensureLinks(node) {
    if (!Array.isArray(node.links)) node.links = [];
    return node.links;
  }

  /**
   * All connected node IDs for a node (outgoing + incoming).
   * Bidirectional: links stored on either side count.
   */
  function getConnectedIds(nodeId) {
    const ids = new Set();
    if (!mapData) return ids;
    const found = findNode(mapData.root, nodeId);
    if (found) {
      ensureLinks(found.node).forEach(id => ids.add(id));
    }
    // incoming
    walkNodes(mapData.root, (n) => {
      if (n.id !== nodeId && ensureLinks(n).includes(nodeId)) {
        ids.add(n.id);
      }
    });
    return ids;
  }

  function getNodeText(id) {
    if (!mapData) return id;
    const f = findNode(mapData.root, id);
    return f ? (f.node.text || "(empty)") : id;
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
    linkMode = false;
    reparentMode = false;
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
    const hasLinks = getConnectedIds(node.id).size > 0;
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node";
    wrapper.dataset.id = node.id;

    const row = document.createElement("div");
    let rowClass = "tree-node-row";
    if (node.id === selectedId) rowClass += " selected";
    if (linkMode && node.id !== selectedId) rowClass += " link-target";
    if (linkMode && node.id === selectedId) rowClass += " link-source";
    if (reparentMode && node.id === selectedId) rowClass += " reparent-source";
    if (reparentMode && node.id !== selectedId) rowClass += " reparent-target";
    row.className = rowClass;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (linkMode) {
        completeLink(node.id);
      } else if (reparentMode) {
        completeReparent(node.id);
      } else {
        selectNode(node.id);
      }
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
    label.className = "node-label" + (node.note ? " has-note" : "") + (hasLinks ? " has-link" : "");
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
    if (linkMode) cancelLinkMode();
    if (reparentMode) cancelReparentMode();
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
    const connected = [...getConnectedIds(node.id)];

    let linksHtml = "";
    if (connected.length === 0) {
      linksHtml = `<p class="links-empty">No connections. Click <strong>🔗 Link</strong> then select another node.</p>`;
    } else {
      linksHtml = `<ul class="link-list">` + connected.map(id => {
        const text = escapeHtml(getNodeText(id));
        return `<li>
          <button type="button" class="link-goto" data-id="${escapeAttr(id)}" title="Go to node">${text}</button>
          <button type="button" class="link-remove" data-id="${escapeAttr(id)}" title="Remove connection">✕</button>
        </li>`;
      }).join("") + `</ul>`;
    }

    editorEl.className = "";
    editorEl.innerHTML = `
      <div class="field">
        <label for="node-text">Node Text</label>
        <input type="text" id="node-text" value="${escapeAttr(node.text)}" />
      </div>
      <div class="field">
        <label for="node-note">Note</label>
        <textarea id="node-note" rows="6" placeholder="Optional note for this node…">${escapeHtml(node.note || "")}</textarea>
      </div>
      <div class="field">
        <label>Connected nodes</label>
        <div class="links-panel">${linksHtml}</div>
      </div>
      <div class="meta">
        ID: <code>${escapeHtml(node.id)}</code>
        &nbsp;·&nbsp; Children: ${node.children ? node.children.length : 0}
        &nbsp;·&nbsp; Links: ${connected.length}
      </div>
    `;

    const textInput = $("#node-text");
    const noteInput = $("#node-note");

    textInput.addEventListener("input", () => {
      node.text = textInput.value;
      setDirty(true);
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

    editorEl.querySelectorAll(".link-goto").forEach(btn => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.id;
        // Expand ancestors so the target is visible
        expandPathTo(targetId);
        selectNode(targetId);
        // Scroll into view
        requestAnimationFrame(() => {
          const el = treeEl.querySelector(`[data-id="${targetId}"] > .tree-node-row`);
          if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      });
    });

    editorEl.querySelectorAll(".link-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        removeLink(selectedId, btn.dataset.id);
      });
    });

    textInput.focus();
    textInput.select();
  }

  function updateToolbar() {
    const hasMap = !!currentName;
    const modeActive = linkMode || reparentMode;
    btnSave.disabled = !hasMap || !dirty;
    btnDownload.disabled = !hasMap;
    btnDeleteMap.disabled = !hasMap;
    btnAddChild.disabled = !selectedId || modeActive;

    const found = selectedId && mapData ? findNode(mapData.root, selectedId) : null;
    const isRoot = !!(mapData && selectedId === mapData.root.id);
    const parent = found && found.parent;
    const siblings = parent ? parent.children : null;
    const idx = siblings ? siblings.indexOf(found.node) : -1;

    btnAddSibling.disabled = !selectedId || isRoot || modeActive;
    btnDeleteNode.disabled = !selectedId || isRoot || modeActive;
    btnMoveUp.disabled = !siblings || idx <= 0 || modeActive;
    btnMoveDown.disabled = !siblings || idx < 0 || idx >= siblings.length - 1 || modeActive;
    btnSortChildren.disabled = !found || !found.node.children || found.node.children.length < 2 || modeActive;

    btnLink.disabled = !selectedId || reparentMode;
    btnLink.classList.toggle("active", linkMode);
    btnLink.title = linkMode ? "Cancel linking (Esc)" : "Connect to another node";

    btnReparent.disabled = !selectedId || isRoot || linkMode;
    btnReparent.classList.toggle("active", reparentMode);
    btnReparent.title = reparentMode
      ? "Cancel move (Esc)"
      : "Move node under another parent";

    document.body.classList.toggle("link-mode", linkMode);
    document.body.classList.toggle("reparent-mode", reparentMode);
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
      links: [],
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
      links: [],
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

    // Collect IDs being removed (node + descendants)
    const removed = new Set();
    walkNodes(found.node, n => removed.add(n.id));

    // Strip links to/from removed nodes across the whole tree
    walkNodes(mapData.root, n => {
      if (removed.has(n.id)) return;
      n.links = ensureLinks(n).filter(id => !removed.has(id));
    });

    const idx = found.parent.children.indexOf(found.node);
    found.parent.children.splice(idx, 1);
    selectedId = found.parent.id;
    setDirty(true);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  // ---------- linking ----------
  function startLinkMode() {
    if (!selectedId || !mapData) return;
    if (linkMode) {
      cancelLinkMode();
      return;
    }
    linkMode = true;
    setStatus("Link mode: click another node to connect (Esc to cancel)");
    renderTree();
    updateToolbar();
  }

  function cancelLinkMode() {
    if (!linkMode) return;
    linkMode = false;
    setStatus("");
    renderTree();
    updateToolbar();
  }

  function completeLink(targetId) {
    if (!linkMode || !selectedId || !mapData) return;
    if (targetId === selectedId) {
      setStatus("Cannot link a node to itself", true);
      return;
    }
    const src = findNode(mapData.root, selectedId);
    const dst = findNode(mapData.root, targetId);
    if (!src || !dst) return;

    const srcLinks = ensureLinks(src.node);
    const dstLinks = ensureLinks(dst.node);

    // Bidirectional
    if (!srcLinks.includes(targetId)) srcLinks.push(targetId);
    if (!dstLinks.includes(selectedId)) dstLinks.push(selectedId);

    linkMode = false;
    setDirty(true);
    setStatus(`Linked “${src.node.text || "(empty)"}” ↔ “${dst.node.text || "(empty)"}”`);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  function removeLink(aId, bId) {
    if (!mapData) return;
    const a = findNode(mapData.root, aId);
    const b = findNode(mapData.root, bId);
    if (a) a.node.links = ensureLinks(a.node).filter(id => id !== bId);
    if (b) b.node.links = ensureLinks(b.node).filter(id => id !== aId);
    setDirty(true);
    renderTree();
    renderEditor();
    updateToolbar();
    setStatus("Connection removed");
  }

  // ---------- reparent (move under another node) ----------
  function startReparentMode() {
    if (!selectedId || !mapData) return;
    if (selectedId === mapData.root.id) {
      setStatus("Cannot move the root node", true);
      return;
    }
    if (reparentMode) {
      cancelReparentMode();
      return;
    }
    if (linkMode) cancelLinkMode();
    reparentMode = true;
    setStatus("Move mode: click the new parent node (Esc to cancel)");
    renderTree();
    updateToolbar();
  }

  function cancelReparentMode() {
    if (!reparentMode) return;
    reparentMode = false;
    setStatus("");
    renderTree();
    updateToolbar();
  }

  function isDescendantOf(ancestorId, nodeId) {
    const anc = findNode(mapData.root, ancestorId);
    if (!anc) return false;
    let found = false;
    walkNodes(anc.node, n => {
      if (n.id === nodeId) found = true;
    });
    return found;
  }

  function completeReparent(newParentId) {
    if (!reparentMode || !selectedId || !mapData) return;

    if (newParentId === selectedId) {
      setStatus("Cannot move a node under itself", true);
      return;
    }

    // Prevent moving a node under one of its own descendants (would cycle)
    if (isDescendantOf(selectedId, newParentId)) {
      setStatus("Cannot move a node under its own descendant", true);
      return;
    }

    const moving = findNode(mapData.root, selectedId);
    const newParent = findNode(mapData.root, newParentId);
    if (!moving || !moving.parent || !newParent) return;

    // Already under this parent?
    if (moving.parent.id === newParentId) {
      setStatus("Node is already under that parent", true);
      cancelReparentMode();
      return;
    }

    // Detach from old parent
    const oldSiblings = moving.parent.children;
    const idx = oldSiblings.indexOf(moving.node);
    if (idx >= 0) oldSiblings.splice(idx, 1);

    // Attach under new parent
    if (!newParent.node.children) newParent.node.children = [];
    newParent.node.children.push(moving.node);
    newParent.node._collapsed = false;

    reparentMode = false;
    setDirty(true);
    setStatus(`Moved “${moving.node.text || "(empty)"}” under “${newParent.node.text || "(empty)"}”`);
    expandPathTo(selectedId);
    renderTree();
    renderEditor();
    updateToolbar();
  }

  /** Expand collapsed ancestors so targetId is visible in the tree. */
  function expandPathTo(targetId) {
    if (!mapData) return;
    function seek(node) {
      if (node.id === targetId) return true;
      for (const c of node.children || []) {
        if (seek(c)) {
          node._collapsed = false;
          return true;
        }
      }
      return false;
    }
    seek(mapData.root);
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
  btnLink.addEventListener("click", startLinkMode);
  btnReparent.addEventListener("click", startReparentMode);
  btnDeleteNode.addEventListener("click", deleteNode);

  mapSelect.addEventListener("change", () => {
    const name = mapSelect.value;
    if (name) openMap(name).catch(e => setStatus(e.message, true));
  });

  // keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (linkMode) {
        e.preventDefault();
        cancelLinkMode();
        return;
      }
      if (reparentMode) {
        e.preventDefault();
        cancelReparentMode();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "s") {
        e.preventDefault();
        if (!btnSave.disabled) saveMap().catch(err => setStatus(err.message, true));
      }
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        if (!btnLink.disabled) startLinkMode();
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        if (!btnReparent.disabled) startReparentMode();
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
