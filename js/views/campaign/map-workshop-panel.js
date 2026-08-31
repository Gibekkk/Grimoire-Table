import { db } from "../../db.js";
import { h, toast, escapeHtml } from "../../util.js";
import { compressImageToBase64, IMAGE_PRESETS } from "../../image-utils.js";

export function mountMapWorkshopPanel(container, { campaignId, isDm }) {
  if (!isDm) {
    container.appendChild(h("div", { class: "empty-state" }, "<h3>DM tools</h3><p>Only the DM builds maps and components here.</p>"));
    return () => {};
  }

  const subTabs = h("div", { class: "sub-tabs" });
  const maps = h("button", { class: "sub-tab-btn active" }, "Maps");
  const components = h("button", { class: "sub-tab-btn" }, "Component Library");
  subTabs.appendChild(maps); subTabs.appendChild(components);
  container.appendChild(subTabs);

  const body = h("div", {});
  container.appendChild(body);

  let active = "maps";
  let unmountBody = null;
  function show(which) {
    active = which;
    maps.classList.toggle("active", which === "maps");
    components.classList.toggle("active", which === "components");
    unmountBody?.();
    body.innerHTML = "";
    unmountBody = which === "maps" ? renderMapsTab(body, campaignId) : renderComponentsTab(body, campaignId);
  }
  maps.addEventListener("click", () => show("maps"));
  components.addEventListener("click", () => show("components"));
  show("maps");

  return () => unmountBody?.();
}

function renderMapsTab(container, campaignId) {
  const createCard = h("div", { class: "card" });
  createCard.appendChild(h("h3", {}, "New Map"));
  const nameInput = h("input", { type: "text", placeholder: "Map name, e.g. \u2018Dragon's Rest Tavern\u2019" });
  createCard.appendChild(h("label", {}, "Name")); createCard.appendChild(nameInput);

  const gridRow = h("div", { class: "field-row" });
  const gridInput = h("input", { type: "number", value: "70", placeholder: "Pixels per 5ft square" });
  gridRow.appendChild(gridInput);
  createCard.appendChild(h("label", {}, "Grid size")); createCard.appendChild(gridRow);
  createCard.appendChild(h("p", { class: "hint" }, "After uploading a background, measure one square in the image and set its pixel width here \u2014 this keeps the ruler and 5ft grid accurate."));

  const fileInput = h("input", { type: "file", accept: "image/*" });
  createCard.appendChild(h("label", {}, "Background image")); createCard.appendChild(fileInput);

  const createBtn = h("button", { class: "btn primary" }, "Create Map");
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { toast("Name the map first", "error"); return; }
    let backgroundBase64 = null, widthPx = 1200, heightPx = 800;
    if (fileInput.files?.[0]) {
      const result = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.mapBackground);
      backgroundBase64 = result.dataUrl; widthPx = result.width; heightPx = result.height;
    }
    await db.maps.create(campaignId, { name, backgroundBase64, gridPx: parseInt(gridInput.value, 10) || 70, widthPx, heightPx });
    toast(`${name} created`);
    nameInput.value = ""; fileInput.value = "";
  });
  createCard.appendChild(createBtn);
  container.appendChild(createCard);

  const listCard = h("div", { class: "card" });
  listCard.appendChild(h("h3", {}, "Your Maps"));
  const list = h("div", {});
  listCard.appendChild(list);
  container.appendChild(listCard);

  const unsub = db.maps.subscribeList(campaignId, (mapsList) => {
    list.innerHTML = "";
    if (mapsList.length === 0) { list.appendChild(h("p", {}, "No maps yet.")); return; }
    mapsList.forEach(map => {
      const row = h("div", { class: "inventory-item" });
      row.innerHTML = `<div class="row1"><div><div class="item-name">${escapeHtml(map.name)}</div><div class="item-meta">Grid: ${map.gridPx}px = 5ft</div></div></div>`;
      const actions = h("div", { class: "row-actions" });
      const delBtn = h("button", { class: "btn sm ghost" }, "Delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete map "${map.name}" and all its tokens?`)) return;
        await db.maps.remove(campaignId, map.id);
      });
      actions.appendChild(delBtn);
      row.appendChild(actions);
      list.appendChild(row);
    });
  });
  return unsub;
}

function renderComponentsTab(container, campaignId) {
  let folders = [];
  const folderCard = h("div", { class: "card" });
  folderCard.appendChild(h("h3", {}, "Folders"));
  const folderRow = h("div", { class: "field-row" });
  const folderInput = h("input", { type: "text", placeholder: "Folder name, e.g. \u2018Tavern Furniture\u2019" });
  const folderBtn = h("button", { class: "btn sm" }, "Add Folder");
  folderBtn.addEventListener("click", async () => {
    if (!folderInput.value.trim()) return;
    await db.componentFolders.add(campaignId, { name: folderInput.value.trim() });
    folderInput.value = "";
  });
  folderRow.appendChild(folderInput); folderRow.appendChild(folderBtn);
  folderCard.appendChild(folderRow);
  const folderList = h("div", { style: "margin-top:10px;" });
  folderCard.appendChild(folderList);
  container.appendChild(folderCard);

  const createCard = h("div", { class: "card" });
  createCard.appendChild(h("h3", {}, "New Component"));
  const nameInput = h("input", { type: "text", placeholder: "e.g. \u2018Oak Table\u2019, \u2018Stone Pillar\u2019" });
  createCard.appendChild(h("label", {}, "Name")); createCard.appendChild(nameInput);
  const folderSelect = h("select", {});
  createCard.appendChild(h("label", {}, "Folder")); createCard.appendChild(folderSelect);
  const sizeRow = h("div", { class: "field-row" });
  const wInput = h("input", { type: "number", value: "1", step: "0.5", placeholder: "Width (grid squares)" });
  const hInput = h("input", { type: "number", value: "1", step: "0.5", placeholder: "Height (grid squares)" });
  sizeRow.appendChild(wInput); sizeRow.appendChild(hInput);
  createCard.appendChild(h("label", {}, "Default size (in 5ft squares)")); createCard.appendChild(sizeRow);
  const coverRow = h("label", { style: "display:flex; align-items:center; gap:8px; text-transform:none; margin-bottom:10px;" });
  const coverCheck = h("input", { type: "checkbox", style: "width:auto; margin:0;" });
  coverRow.appendChild(coverCheck); coverRow.appendChild(document.createTextNode(" This object provides cover"));
  createCard.appendChild(coverRow);
  const coverTypeSelect = h("select", {});
  [["half", "Half Cover (+2 AC)"], ["threeQuarters", "Three-Quarters Cover (+5 AC)"], ["total", "Total Cover (can't be targeted)"]].forEach(([v, l]) => coverTypeSelect.appendChild(h("option", { value: v }, l)));
  createCard.appendChild(coverTypeSelect);
  const fileInput = h("input", { type: "file", accept: "image/*" });
  createCard.appendChild(h("label", { style: "margin-top:10px;" }, "Image")); createCard.appendChild(fileInput);

  const createBtn = h("button", { class: "btn primary" }, "Add to Library");
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { toast("Name the component first", "error"); return; }
    let imageBase64 = null;
    if (fileInput.files?.[0]) {
      const result = await compressImageToBase64(fileInput.files[0], IMAGE_PRESETS.component);
      imageBase64 = result.dataUrl;
    }
    await db.componentLibrary.add(campaignId, {
      name, imageBase64, folderId: folderSelect.value || null,
      defaultW: parseFloat(wInput.value) || 1, defaultH: parseFloat(hInput.value) || 1,
      isCover: coverCheck.checked, coverType: coverTypeSelect.value
    });
    toast(`${name} added to the library`);
    nameInput.value = ""; fileInput.value = "";
  });
  createCard.appendChild(createBtn);
  container.appendChild(createCard);

  const libCard = h("div", { class: "card" });
  libCard.appendChild(h("h3", {}, "Library"));
  const libList = h("div", {});
  libCard.appendChild(libList);
  container.appendChild(libCard);

  function renderFolderOptions() {
    folderSelect.innerHTML = "";
    folderSelect.appendChild(h("option", { value: "" }, "No folder"));
    folders.forEach(f => folderSelect.appendChild(h("option", { value: f.id }, f.name)));
  }

  const unsubFolders = db.componentFolders.subscribe(campaignId, (f) => {
    folders = f;
    renderFolderOptions();
    folderList.innerHTML = "";
    folders.forEach(folder => {
      const chip = h("span", { class: "badge", style: "margin-right:6px; cursor:pointer;" }, `${folder.name} \u00d7`);
      chip.addEventListener("click", async () => {
        if (confirm(`Delete folder "${folder.name}"? Components inside move to "No folder".`)) await db.componentFolders.remove(campaignId, folder.id);
      });
      folderList.appendChild(chip);
    });
  });

  const unsubLib = db.componentLibrary.subscribe(campaignId, (items) => {
    libList.innerHTML = "";
    if (items.length === 0) { libList.appendChild(h("p", {}, "No components yet.")); return; }
    const grouped = {};
    items.forEach(c => { const key = c.folderId || "__none__"; grouped[key] = grouped[key] || []; grouped[key].push(c); });
    Object.entries(grouped).forEach(([folderId, comps]) => {
      const folderName = folders.find(f => f.id === folderId)?.name || "No folder";
      libList.appendChild(h("h4", { style: "margin-top:14px;" }, folderName));
      comps.forEach(c => {
        const row = h("div", { class: "inventory-item" });
        row.innerHTML = `<div class="row1"><div><div class="item-name">${escapeHtml(c.name)} ${c.isCover ? `<span class="badge rune">${c.coverType} cover</span>` : ""}</div><div class="item-meta">${c.defaultW}\u00d7${c.defaultH} squares</div></div></div>`;
        const delBtn = h("button", { class: "btn sm ghost" }, "Delete");
        delBtn.addEventListener("click", () => db.componentLibrary.remove(campaignId, c.id));
        const actions = h("div", { class: "row-actions" }); actions.appendChild(delBtn);
        row.appendChild(actions);
        libList.appendChild(row);
      });
    });
  });

  return () => { unsubFolders(); unsubLib(); };
}
