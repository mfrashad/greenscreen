(() => {
  const $ = (sel) => document.querySelector(sel);
  const canvas = $("#corner-canvas");
  const ctx = canvas.getContext("2d");

  let baseFile = null;
  let baseImg = null;          // HTMLImageElement for canvas drawing
  let ssFiles = [];            // File[]
  let selectedSsIdx = 0;

  let corners = null;          // [[x,y],..] in image pixel coords
  let originalCorners = null;  // for reset
  let imgW = 0, imgH = 0;     // full-res image dimensions
  let canvasScale = 1;         // canvas pixel coords -> image pixel coords

  let draggingIdx = -1;
  let debounceTimer = null;
  let showOverlay = true;
  let lastPreviewImg = null;   // cached preview Image for redraw
  let selectedTemplateId = null; // currently selected predefined template

  // Expose state for debugging/saving
  window.__gs = () => ({ corners, originalCorners, imgW, imgH, selectedTemplateId });

  // -- Zoom & Pan state ----------------------------------------------------

  let zoom = 1;
  let panX = 0, panY = 0;     // pan offset in canvas pixel coords
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panStartPanX = 0, panStartPanY = 0;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const HANDLE_SCREEN_PX = 20; // hit target in screen pixels

  // -- Upload zones --------------------------------------------------------

  function setupDropZone(zoneEl, inputEl, onFiles, contentGuard) {
    zoneEl.addEventListener("click", (e) => {
      // If there's a content guard (canvas or ss-content) that's visible,
      // don't open file picker on general zone clicks
      if (contentGuard && contentGuard.classList.contains("visible")) return;
      inputEl.click();
    });
    inputEl.addEventListener("change", () => {
      if (inputEl.files.length) onFiles([...inputEl.files]);
    });
    zoneEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      zoneEl.classList.add("dragover");
    });
    zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("dragover"));
    zoneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      zoneEl.classList.remove("dragover");
      if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    });
  }

  setupDropZone($("#base-upload-zone"), $("#base-input"), (files) => {
    baseFile = files[0];
    selectedTemplateId = null;
    document.querySelectorAll(".template-thumb").forEach((el) => el.classList.remove("selected"));
    uploadBase();
  }, canvas);

  setupDropZone($("#ss-upload-zone"), $("#ss-input"), (files) => {
    ssFiles = ssFiles.concat(files);
    if (selectedSsIdx >= ssFiles.length) selectedSsIdx = 0;
    renderSsThumbs();
    updateButtons();
  }, $("#ss-content"));

  // -- Template picker ------------------------------------------------------

  async function loadTemplates() {
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) return;
      const data = await res.json();
      const scroll = $("#template-scroll");
      scroll.innerHTML = "";

      data.templates.forEach((tmpl) => {
        const img = document.createElement("img");
        img.className = "template-thumb";
        img.src = `/static/templates/thumbs/${tmpl.filename}`;
        img.title = tmpl.id;
        img.dataset.id = tmpl.id;
        img.addEventListener("click", () => selectTemplate(tmpl));
        scroll.appendChild(img);
      });
    } catch (e) {
      // Silently fail — templates are optional
    }
  }

  async function selectTemplate(tmpl) {
    const zone = $("#base-upload-zone");
    setStatus("Loading template...");
    showLoading(zone, "Loading template...");

    // Highlight selected thumbnail
    document.querySelectorAll(".template-thumb").forEach((el) => {
      el.classList.toggle("selected", el.dataset.id === tmpl.id);
    });
    selectedTemplateId = tmpl.id;

    // Set pre-detected corners (no /api/detect call needed)
    corners = tmpl.corners;
    originalCorners = JSON.parse(JSON.stringify(tmpl.corners));
    imgW = tmpl.width;
    imgH = tmpl.height;

    // Fetch full-res JPEG and create a File blob for existing endpoints
    try {
      const resp = await fetch(`/static/templates/${tmpl.filename}`);
      if (!resp.ok) throw new Error("Failed to fetch template image");
      const blob = await resp.blob();
      baseFile = new File([blob], tmpl.filename, { type: "image/jpeg" });

      // Load into canvas
      const url = URL.createObjectURL(blob);
      baseImg = new Image();
      baseImg.onload = () => {
        zoom = 1; panX = 0; panY = 0;
        lastPreviewImg = null;
        initCanvas();
        drawCanvas();
        updateZoomLabel();
        removeLoading(zone);
        setStatus("Template loaded. Drag handles to adjust corners.", "success");
        URL.revokeObjectURL(url);
      };
      baseImg.src = url;

      $("#base-prompt").classList.add("hidden");
      canvas.classList.add("visible");
      $("#base-upload-zone").classList.add("has-content");
      updateButtons();
    } catch (err) {
      removeLoading(zone);
      setStatus("Failed to load template: " + err.message, "error");
    }
  }

  loadTemplates();

  // -- Base upload & detect ------------------------------------------------

  async function uploadBase() {
    const zone = $("#base-upload-zone");
    setStatus("Uploading base image...");
    showLoading(zone, "Uploading & detecting green screen...");

    const form = new FormData();
    form.append("base", baseFile);

    try {
      const res = await fetch("/api/detect", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      corners = data.corners;
      originalCorners = JSON.parse(JSON.stringify(corners));
      imgW = data.width;
      imgH = data.height;

      baseImg = new Image();
      baseImg.onload = () => {
        zoom = 1; panX = 0; panY = 0;
        lastPreviewImg = null;
        initCanvas();
        drawCanvas();
        updateZoomLabel();
        removeLoading(zone);
        setStatus("Corners detected. Drag handles to adjust. Scroll to zoom.", "success");
      };
      baseImg.src = "data:image/jpeg;base64," + data.image;

      $("#base-prompt").classList.add("hidden");
      canvas.classList.add("visible");
      $("#base-upload-zone").classList.add("has-content");
      updateButtons();
    } catch (err) {
      removeLoading(zone);
      setStatus("Detection failed: " + err.message, "error");
    }
  }

  // -- Canvas --------------------------------------------------------------

  function initCanvas() {
    const parent = canvas.parentElement;
    const parentRect = parent.getBoundingClientRect();
    const maxW = parentRect.width - 4;  // account for border
    const maxH = parentRect.height - 4;
    const aspect = baseImg.naturalHeight / baseImg.naturalWidth;

    // Fit within parent, preserving aspect ratio
    let dispW = maxW;
    let dispH = dispW * aspect;
    if (dispH > maxH) {
      dispH = maxH;
      dispW = dispH / aspect;
    }

    canvas.width = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    canvas.style.width = dispW + "px";
    canvas.style.height = dispH + "px";

    canvasScale = imgW / baseImg.naturalWidth;
  }

  // Get the ratio: how many canvas pixels per screen pixel
  function getDisplayScale() {
    const rect = canvas.getBoundingClientRect();
    return {
      sx: canvas.width / rect.width,
      sy: canvas.height / rect.height,
    };
  }

  // Convert screen-relative mouse coords (relative to canvas element) to
  // content coords (canvas pixel space, zoom+pan removed)
  function screenToContent(mx, my) {
    const { sx, sy } = getDisplayScale();
    const rawX = mx * sx;
    const rawY = my * sy;
    return [(rawX - panX) / zoom, (rawY - panY) / zoom];
  }

  function canvasToImage(cx, cy) {
    return [cx * canvasScale, cy * canvasScale];
  }

  function imageToCanvas(ix, iy) {
    return [ix / canvasScale, iy / canvasScale];
  }

  // Hit-test threshold in content-space (canvas pixels) that corresponds
  // to HANDLE_SCREEN_PX on screen, accounting for display scale and zoom.
  function hitThreshold() {
    const { sx } = getDisplayScale();
    // screen px -> raw canvas px -> content px (undo zoom)
    return (HANDLE_SCREEN_PX * sx) / zoom;
  }

  function findHandleAt(cx, cy) {
    if (!corners || !showOverlay) return -1;
    const thresh = hitThreshold();
    for (let i = 0; i < corners.length; i++) {
      const [px, py] = imageToCanvas(corners[i][0], corners[i][1]);
      if (Math.hypot(cx - px, cy - py) < thresh) return i;
    }
    return -1;
  }

  function fullRedraw() {
    if (lastPreviewImg) {
      redrawPreview();
    } else {
      drawCanvas();
    }
  }

  function drawCanvas() {
    if (!baseImg || !corners) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    ctx.drawImage(baseImg, 0, 0);

    if (showOverlay) drawOverlayHandles();

    ctx.restore();
  }

  function drawOverlayHandles() {
    const pts = corners.map(([x, y]) => imageToCanvas(x, y));

    // Fill
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = "rgba(74, 222, 128, 0.15)";
    ctx.fill();

    // Outline
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();

    // Handles -- size in screen pixels, not content pixels
    const { sx } = getDisplayScale();
    const RADIUS = (10 * sx) / zoom;  // 10 screen px
    const fontSize = (13 * sx) / zoom;
    const labelOffset = (14 * sx) / zoom;

    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = draggingIdx === i ? "#ef4444" : "#4ade80";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 / zoom;
      ctx.stroke();

      const labels = ["TL", "TR", "BR", "BL"];
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.fillText(labels[i], x + labelOffset, y - labelOffset * 0.6);
    });
  }

  function redrawPreview() {
    if (!lastPreviewImg) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    ctx.drawImage(lastPreviewImg, 0, 0, canvas.width, canvas.height);

    if (showOverlay) drawPreviewOverlay();

    ctx.restore();
  }

  function drawPreviewOverlay() {
    if (!corners) return;
    const pts = corners.map(([x, y]) => imageToCanvas(x, y));
    const { sx } = getDisplayScale();

    ctx.strokeStyle = "rgba(74, 222, 128, 0.5)";
    ctx.lineWidth = 1 / zoom;
    const dash = (4 * sx) / zoom;
    ctx.setLineDash([dash, dash]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    const RADIUS = (7 * sx) / zoom;
    pts.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(74, 222, 128, 0.6)";
      ctx.fill();
    });
  }

  // -- Zoom ----------------------------------------------------------------

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { sx, sy } = getDisplayScale();
    const rawX = mx * sx;
    const rawY = my * sy;

    const oldZoom = zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * delta));

    panX = rawX - (rawX - panX) * (zoom / oldZoom);
    panY = rawY - (rawY - panY) * (zoom / oldZoom);

    clampPan();
    updateZoomLabel();
    fullRedraw();
  }, { passive: false });

  function clampPan() {
    const maxPanX = Math.max(0, canvas.width * zoom - canvas.width);
    const maxPanY = Math.max(0, canvas.height * zoom - canvas.height);
    panX = Math.min(0, Math.max(-maxPanX, panX));
    panY = Math.min(0, Math.max(-maxPanY, panY));
  }

  function updateZoomLabel() {
    const label = $("#zoom-label");
    if (zoom <= 1.01) {
      label.textContent = "";
    } else {
      label.textContent = Math.round(zoom * 100) + "%";
    }
  }

  // -- Mouse interaction (corners + pan) -----------------------------------

  canvas.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!corners) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [cx, cy] = screenToContent(mx, my);

    // Check handle proximity
    const hitIdx = findHandleAt(cx, cy);
    if (hitIdx >= 0) {
      draggingIdx = hitIdx;
      fullRedraw();
      return;
    }

    // If zoomed in and didn't hit a handle, start panning
    if (zoom > 1.01) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartPanX = panX;
      panStartPanY = panY;
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (draggingIdx >= 0) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [cx, cy] = screenToContent(mx, my);
      const [ix, iy] = canvasToImage(cx, cy);
      corners[draggingIdx] = [
        Math.max(0, Math.min(imgW, ix)),
        Math.max(0, Math.min(imgH, iy)),
      ];
      fullRedraw();
      return;
    }

    if (isPanning) {
      const { sx, sy } = getDisplayScale();
      panX = panStartPanX + (e.clientX - panStartX) * sx;
      panY = panStartPanY + (e.clientY - panStartY) * sy;
      clampPan();
      fullRedraw();
      return;
    }

    // Cursor hint
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [cx, cy] = screenToContent(mx, my);
    const nearHandle = findHandleAt(cx, cy) >= 0;

    if (nearHandle) {
      canvas.style.cursor = "crosshair";
    } else if (zoom > 1.01) {
      canvas.style.cursor = "grab";
    } else {
      canvas.style.cursor = "default";
    }
  });

  canvas.addEventListener("mouseup", () => {
    if (draggingIdx >= 0) {
      draggingIdx = -1;
      fullRedraw();
      debouncedPreview();
    }
    if (isPanning) {
      isPanning = false;
      canvas.style.cursor = zoom > 1.01 ? "grab" : "default";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (draggingIdx >= 0) {
      draggingIdx = -1;
      fullRedraw();
    }
    if (isPanning) {
      isPanning = false;
    }
  });

  // Prevent canvas clicks from bubbling to upload zone
  canvas.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // -- Screenshot thumbnails -----------------------------------------------

  function renderSsThumbs() {
    const container = $("#ss-thumbs");
    container.innerHTML = "";

    if (ssFiles.length === 0) {
      $("#ss-prompt").classList.remove("hidden");
      $("#ss-content").classList.remove("visible");
      $("#ss-upload-zone").classList.remove("has-content");
      return;
    }

    $("#ss-prompt").classList.add("hidden");
    $("#ss-content").classList.add("visible");
    $("#ss-upload-zone").classList.add("has-content");

    ssFiles.forEach((file, i) => {
      const item = document.createElement("div");
      item.className = "thumb-item";

      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      if (i === selectedSsIdx) img.classList.add("selected");
      img.addEventListener("click", () => {
        selectedSsIdx = i;
        renderSsThumbs();
        debouncedPreview();
      });
      const view = document.createElement("button");
      view.className = "thumb-fullscreen";
      view.textContent = "View in Fullscreen";
      view.addEventListener("click", (e) => {
        e.stopPropagation();
        openModal(img.src);
      });

      const del = document.createElement("button");
      del.className = "thumb-delete";
      del.textContent = "\u00d7";
      del.title = "Remove";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        ssFiles.splice(i, 1);
        if (selectedSsIdx >= ssFiles.length) selectedSsIdx = Math.max(0, ssFiles.length - 1);
        renderSsThumbs();
        updateButtons();
      });

      item.appendChild(img);
      item.appendChild(view);
      item.appendChild(del);
      container.appendChild(item);
    });
  }

  // "Add more" button
  $("#btn-add-ss").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#ss-input").click();
  });

  // -- Sliders -------------------------------------------------------------

  ["brightness", "contrast", "temperature", "saturation", "blur"].forEach((id) => {
    const input = $(`#${id}`);
    const valSpan = $(`#${id}-val`);
    input.addEventListener("input", () => {
      valSpan.textContent = input.value;
      debouncedPreview();
    });
  });

  // -- Preview -------------------------------------------------------------

  function debouncedPreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(requestPreview, 300);
  }

  let previewInFlight = false;

  async function requestPreview() {
    if (!baseFile || ssFiles.length === 0 || !corners) return;
    if (previewInFlight) return;
    previewInFlight = true;

    const btn = $("#btn-preview");
    setButtonLoading(btn, true, "Previewing");
    setStatus("Generating preview...");

    const form = new FormData();
    form.append("base", baseFile);
    form.append("screenshot", ssFiles[selectedSsIdx]);
    form.append("corners", JSON.stringify(corners));
    form.append("brightness", $("#brightness").value);
    form.append("contrast", $("#contrast").value);
    form.append("temperature", $("#temperature").value);
    form.append("saturation", $("#saturation").value);
    form.append("blur", $("#blur").value);

    try {
      const res = await fetch("/api/preview", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      const img = new Image();
      img.onload = () => {
        lastPreviewImg = img;
        redrawPreview();
      };
      img.src = "data:image/jpeg;base64," + data.image;
      setStatus("Preview updated.", "success");
    } catch (err) {
      setStatus("Preview failed: " + err.message, "error");
    } finally {
      previewInFlight = false;
      setButtonLoading(btn, false);
      updateButtons();
    }
  }

  // -- Process All ---------------------------------------------------------

  let resultBlobs = [];

  async function processOne(file) {
    const form = new FormData();
    form.append("base", baseFile);
    form.append("screenshot", file);
    form.append("corners", JSON.stringify(corners));
    form.append("brightness", $("#brightness").value);
    form.append("contrast", $("#contrast").value);
    form.append("temperature", $("#temperature").value);
    form.append("saturation", $("#saturation").value);
    form.append("blur", $("#blur").value);

    const res = await fetch("/api/process-one", { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());

    const blob = await res.blob();
    const name = file.name.replace(/\.[^.]+$/, "") + "_composite.png";
    return { name, blob, url: URL.createObjectURL(blob) };
  }

  function downloadBlob(name, url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }

  function renderGallery() {
    const gallery = $("#output-gallery");
    gallery.innerHTML = "";

    resultBlobs.forEach(({ name, url }) => {
      const item = document.createElement("div");
      item.className = "gallery-item";

      const img = document.createElement("img");
      img.src = url;
      img.style.cursor = "zoom-in";
      img.addEventListener("click", () => openModal(url));

      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.textContent = "Download";

      item.appendChild(img);
      item.appendChild(link);
      gallery.appendChild(item);
    });

    const dlAll = $("#btn-download-all");
    dlAll.style.display = resultBlobs.length > 1 ? "block" : "none";
  }

  async function processAll() {
    if (!baseFile || ssFiles.length === 0 || !corners) return;

    const total = ssFiles.length;
    const btn = $("#btn-process");
    setButtonLoading(btn, true, `Processing 0/${total}`);
    showProgress(0, total);
    resultBlobs = [];

    try {
      for (let i = 0; i < total; i++) {
        btn.textContent = `Processing ${i + 1}/${total}`;
        setStatus(`Processing ${i + 1} of ${total}...`);
        showProgress(i + 0.5, total);
        const result = await processOne(ssFiles[i]);
        resultBlobs.push(result);
        showProgress(i + 1, total);
        renderGallery();
      }

      if (total === 1) {
        downloadBlob(resultBlobs[0].name, resultBlobs[0].url);
        setStatus("Done! Image downloaded.", "success");
      } else {
        setStatus(`Done! ${total} images ready. Download individually or use Download All.`, "success");
      }
    } catch (err) {
      setStatus("Processing failed: " + err.message, "error");
    } finally {
      setButtonLoading(btn, false);
      hideProgress();
      updateButtons();
    }
  }

  $("#btn-download-all").addEventListener("click", () => {
    resultBlobs.forEach(({ name, url }) => {
      downloadBlob(name, url);
    });
  });

  // -- Buttons -------------------------------------------------------------

  function updateButtons() {
    const hasBase = !!baseFile && !!corners;
    const hasSs = ssFiles.length > 0;
    $("#btn-preview").disabled = !(hasBase && hasSs);
    $("#btn-process").disabled = !(hasBase && hasSs);
  }

  $("#btn-preview").addEventListener("click", requestPreview);
  $("#btn-process").addEventListener("click", processAll);
  $("#btn-reset").addEventListener("click", () => {
    if (originalCorners) {
      corners = JSON.parse(JSON.stringify(originalCorners));
      lastPreviewImg = null;
      zoom = 1; panX = 0; panY = 0;
      updateZoomLabel();
      drawCanvas();
      setStatus("Corners reset to detected positions.", "success");
    }
  });
  $("#btn-toggle-overlay").addEventListener("click", () => {
    showOverlay = !showOverlay;
    $("#btn-toggle-overlay").textContent = showOverlay ? "Hide Guides" : "Show Guides";
    fullRedraw();
  });
  $("#btn-zoom-reset").addEventListener("click", () => {
    zoom = 1; panX = 0; panY = 0;
    updateZoomLabel();
    canvas.style.cursor = "default";
    fullRedraw();
  });

  // -- Status & Loading ----------------------------------------------------

  function setStatus(msg, type = "") {
    const el = $("#status");
    el.textContent = msg;
    el.className = "status" + (type ? " " + type : "");
  }

  function showLoading(parentEl, text) {
    removeLoading(parentEl);
    const overlay = document.createElement("div");
    overlay.className = "loading-overlay";
    overlay.innerHTML = `<div class="spinner"></div><div class="loading-text">${text}</div>`;
    parentEl.appendChild(overlay);
  }

  function removeLoading(parentEl) {
    const existing = parentEl.querySelector(".loading-overlay");
    if (existing) existing.remove();
  }

  function setButtonLoading(btn, loading, loadingText) {
    if (loading) {
      btn._origText = btn.textContent;
      btn.textContent = loadingText || btn.textContent;
      btn.classList.add("loading");
      btn.disabled = true;
    } else {
      btn.textContent = btn._origText || btn.textContent;
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  }

  function showProgress(current, total) {
    const bar = $("#progress-bar");
    const fill = $("#progress-fill");
    bar.classList.add("visible");
    fill.style.width = Math.round((current / total) * 100) + "%";
  }

  function hideProgress() {
    $("#progress-bar").classList.remove("visible");
    $("#progress-fill").style.width = "0%";
  }

  // -- Image preview modal --------------------------------------------------

  const modal = $("#image-modal");
  const modalImg = $("#modal-img");

  function openModal(src) {
    modalImg.src = src;
    modal.classList.add("visible");
  }

  function closeModal() {
    modal.classList.remove("visible");
    modalImg.src = "";
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  $("#modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("visible")) closeModal();
  });
})();
