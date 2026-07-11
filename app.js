// Guard: make sure the library loaded (checks both V86 and V86Starter)
const V86Constructor = typeof V86 !== "undefined" ? V86 : (typeof V86Starter !== "undefined" ? V86Starter : null);

if (!V86Constructor) {
  console.error("[v86] Neither V86 nor V86Starter is defined — libv86.js failed to load");
  document.getElementById('hud-message').innerHTML =
    '<strong style="color:#ff3b69">V86 LIBRARY NOT LOADED</strong>The emulator script failed to load from CDN. Check browser console (F12) for errors.';
} else {
  console.log("[v86] Constructor found:", V86Constructor.name || "V86");
}

const V86_CDN  = "";
const V86_BIOS = "";

let emulator = null;
let isoFile = null;
let stateBuffer = null;

// DOM Elements
const isoUpload         = document.getElementById('iso-upload');
const stateUpload     = document.getElementById('state-upload');
const fileInfo         = document.getElementById('file-info');
const btnStart         = document.getElementById('btn-start');
const btnPause         = document.getElementById('btn-pause');
const btnSaveState     = document.getElementById('btn-save-state');
const btnReset         = document.getElementById('btn-reset');
const btnFullscreen    = document.getElementById('btn-fullscreen');
const hud              = document.getElementById('screen-hud');
const hudSpinner       = document.getElementById('hud-spinner');
const hudMessage       = document.getElementById('hud-message');
const statState        = document.getElementById('stat-state');
const statCores        = document.getElementById('stat-cores');
const globalStatusDot  = document.getElementById('global-status-dot');
const globalStatusText = document.getElementById('global-status-text');

const presetSelect     = document.getElementById('preset-select');
const autosaveToggle   = document.getElementById('autosave-toggle');
const btnRestore       = document.getElementById('btn-restore-session');

if (navigator.hardwareConcurrency) {
  statCores.textContent = navigator.hardwareConcurrency + ' Cores';
}

// ── IndexedDB Session Storage Manager ──
const DB_NAME = "WebVM_Session_DB";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const STATE_KEY = "latest_state";
const META_KEY = "latest_metadata";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = function(e) {
      resolve(e.target.result);
    };
    request.onerror = function(e) {
      reject(e.target.error);
    };
  });
}

async function saveSessionToDB(binState, filename) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    
    await store.put(binState, STATE_KEY);
    await store.put({ filename: filename, timestamp: Date.now() }, META_KEY);
    
    await new Promise((resolve) => {
      tx.oncomplete = () => resolve();
    });
    console.log("[IndexedDB] Session auto-saved successfully!");
    updateRestoreButton();
  } catch (err) {
    console.error("[IndexedDB] Auto-save write failed:", err);
  }
}

async function loadSessionFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    
    const stateReq = store.get(STATE_KEY);
    const metaReq = store.get(META_KEY);
    
    const state = await new Promise((resolve) => {
      stateReq.onsuccess = () => resolve(stateReq.result);
    });
    const meta = await new Promise((resolve) => {
      metaReq.onsuccess = () => resolve(metaReq.result);
    });
    
    if (state && meta) {
      return { state, meta };
    }
  } catch (err) {
    console.error("[IndexedDB] Read failed:", err);
  }
  return null;
}

async function updateRestoreButton() {
  if (!btnRestore) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(META_KEY);
    
    request.onsuccess = function() {
      const meta = request.result;
      if (meta) {
        btnRestore.disabled = false;
        btnRestore.innerHTML = `<i class="fa-solid fa-clock-rotate-left" style="color: var(--green);"></i> Resume: ${meta.filename}`;
      } else {
        btnRestore.disabled = true;
        btnRestore.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> Restore Last Session`;
      }
    };
  } catch (err) {
    btnRestore.disabled = true;
  }
}

// ── ISO/Disk File selection ──
isoUpload.addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  isoFile = file;
  stateBuffer = null; // Clear previous state buffer
  if (presetSelect) presetSelect.value = ""; // Reset preset selector

  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  const ext = file.name.substring(file.name.lastIndexOf('.')).toUpperCase();
  fileInfo.textContent = ext.substring(1) + ': ' + file.name + ' (' + sizeMB + ' MB)';
  fileInfo.style.display = 'block';

  console.log('[v86] File selected: ' + file.name + ' (' + sizeMB + ' MB)');
  hudMessage.innerHTML = '<strong>IMAGE LOADED</strong>Click <strong>Start Boot</strong> to boot the OS.';
  btnStart.disabled = false;
});

// ── State File selection ──
stateUpload.addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  fileInfo.textContent = 'State: ' + file.name + ' (' + sizeMB + ' MB)';
  fileInfo.style.display = 'block';

  hudSpinner.style.display = 'block';
  hudMessage.innerHTML = '<strong>BUFFERING STATE FILE</strong>Loading ' + sizeMB + ' MB...';

  try {
    stateBuffer = await file.arrayBuffer();
    isoFile = null; // State file takes precedence
    if (presetSelect) presetSelect.value = ""; // Reset preset selector
    console.log('[v86] State file loaded successfully. Size:', stateBuffer.byteLength);
    hudSpinner.style.display = 'none';
    hudMessage.innerHTML = '<strong>STATE LOADED SUCCESSFULLY</strong>Click <strong>Start Boot</strong> to restore system state in 1s.';
    btnStart.disabled = false;
  } catch (err) {
    console.error('[v86] State read error:', err);
    hudSpinner.style.display = 'none';
    hudMessage.innerHTML = '<strong style="color:#ff3b69">STATE FILE READ ERROR</strong>' + err.message;
  }
});

// ── Preset Selection dropdown handler ──
if (presetSelect) {
  presetSelect.addEventListener('change', function() {
    if (this.value) {
      isoFile = null;
      stateBuffer = null;
      isoUpload.value = "";
      stateUpload.value = "";
      
      const filename = this.value.substring(this.value.lastIndexOf('/') + 1);
      fileInfo.textContent = "Preset: " + filename;
      fileInfo.style.display = 'block';
      
      hudMessage.innerHTML = '<strong>PRESET SELECTED</strong>Click <strong>Start Boot</strong> to boot ' + filename + '.';
      btnStart.disabled = false;
    } else {
      fileInfo.style.display = 'none';
      btnStart.disabled = true;
      hudMessage.innerHTML = '<strong>SYSTEM INACTIVE</strong>Please select an operating system image file in the sidebar to load the WebAssembly kernel.';
    }
  });
}

// ── Restore Session from DB handler ──
if (btnRestore) {
  btnRestore.addEventListener('click', async function() {
    hudSpinner.style.display = 'block';
    hudMessage.innerHTML = '<strong>READING INDEXEDDB SESSION</strong>Loading saved state...';
    hud.style.display = 'flex';
    hud.style.opacity = '1';

    const session = await loadSessionFromDB();
    if (!session) {
      alert("No saved session found in IndexedDB!");
      hudSpinner.style.display = 'none';
      hud.style.display = 'none';
      return;
    }

    stateBuffer = session.state;
    isoFile = null;
    if (presetSelect) presetSelect.value = ""; // Reset preset
    
    fileInfo.textContent = "Restored: " + session.meta.filename;
    fileInfo.style.display = 'block';

    console.log('[v86] JIT state restored from IndexedDB. Size:', stateBuffer.byteLength);
    btnStart.disabled = false;
    btnStart.click(); // Trigger auto-start boot
  });
}

// ── Auto-save triggers ──
async function triggerAutoSave() {
  if (emulator && autosaveToggle && autosaveToggle.checked) {
    console.log('[v86] Auto-saving session state to IndexedDB...');
    try {
      const state = await emulator.save_state();
      let displayName = "Active Session";
      if (isoFile) {
        displayName = isoFile.name;
      } else if (presetSelect && presetSelect.value) {
        displayName = presetSelect.value.substring(presetSelect.value.lastIndexOf('/') + 1);
      }
      await saveSessionToDB(state, displayName);
    } catch (e) {
      console.warn('[v86] Auto-save skipped/failed:', e);
    }
  }
}

// ── Boot emulator ──
btnStart.addEventListener('click', async function() {
  let presetUrl = presetSelect ? presetSelect.value : "";

  if ((!presetUrl && !isoFile && !stateBuffer) || !V86Constructor) return;

  btnStart.disabled = true;
  hudSpinner.style.display = 'block';
  hudMessage.innerHTML = '<strong>LOADING FIRMWARE</strong>Fetching local SeaBIOS & VGA-BIOS binaries...';
  globalStatusText.textContent = 'BOOTING';
  globalStatusDot.classList.add('active');
  statState.textContent = 'BOOTING';

  // Clean up previous emulator instance if running to prevent double-rendering bugs
  if (emulator) {
    console.log('[v86] Destroying previous emulator instance...');
    try {
      emulator.destroy();
    } catch(e) {
      console.warn('[v86] Error destroying emulator:', e);
    }
    emulator = null;
  }

  // Reset screen DOM elements to remove old canvas layers
  const container = document.getElementById("screen_container");
  container.innerHTML = `
    <div id="screen" style="white-space: pre; font: 14px monospace; line-height: 14px"></div>
    <canvas id="vga" style="display: none"></canvas>
  `;

  console.log('[v86] Fetching BIOS files asynchronously...');

  try {
    const [biosResp, vgaBiosResp] = await Promise.all([
      fetch(V86_BIOS ? V86_BIOS + "/seabios.bin" : "seabios.bin"),
      fetch(V86_BIOS ? V86_BIOS + "/vgabios.bin" : "vgabios.bin")
    ]);

    if (!biosResp.ok || !vgaBiosResp.ok) {
      throw new Error(`BIOS fetch failed: SeaBIOS=${biosResp.status}, VGA-BIOS=${vgaBiosResp.status}`);
    }

    const [biosBuffer, vgaBiosBuffer] = await Promise.all([
      biosResp.arrayBuffer(),
      vgaBiosResp.arrayBuffer()
    ]);

    console.log('[v86] BIOS buffers loaded. Size:', biosBuffer.byteLength, vgaBiosBuffer.byteLength);
    hudMessage.innerHTML = '<strong>INITIALIZING WASM VM</strong>Compiling JIT compilation threads...';

    // Dynamically adjust ACPI and Networking:
    // - KolibriOS (.img) requires ACPI enabled for interrupts, and must have network relay DISABLED
    //   (incoming public network packets trigger NE2000 hardware interrupts that crash the legacy assembly kernel).
    // - Standard Linux ISOs run faster with ACPI disabled, and support network bridging.
    // All images run on a uniform 512MB memory size.
    let memorySize = 512 * 1024 * 1024; 
    let acpiEnabled = false;
    let networkRelayUrl = "wss://relay.widgetry.org/";
    const isImg = (isoFile && isoFile.name.toLowerCase().endsWith(".img")) || 
                  (presetUrl && presetUrl.toLowerCase().endsWith(".img"));
    if (isImg) {
      acpiEnabled = true;
      networkRelayUrl = ""; // Disable network card interrupts for KolibriOS
    }
    
    // Update System Monitor UI
    const statMemory = document.getElementById("stat-memory");
    if (statMemory) {
      statMemory.textContent = (memorySize / (1024 * 1024)) + " MB";
    }

    const config = {
      wasm_path: V86_CDN ? V86_CDN + "/v86.wasm" : "v86.wasm",
      bios:     { buffer: biosBuffer },
      vga_bios: { buffer: vgaBiosBuffer },

      memory_size: memorySize,
      vga_memory_size: 8 * 1024 * 1024,
      screen_container: document.getElementById("screen_container"),

      autostart: true,
      disable_speaker: true, // Optimization: disable speaker emulation
      acpi: acpiEnabled,     // Dynamic ACPI support
      network_relay_url: networkRelayUrl || undefined // Dynamic network bridge
    };

    if (presetUrl) {
      const name = presetUrl.toLowerCase();
      if (name.endsWith(".iso")) {
        config.cdrom = { url: presetUrl, async: true };
      } else if (name.endsWith(".img")) {
        config.fda = { url: presetUrl, async: true };
      } else {
        config.hda = { url: presetUrl, async: true };
      }
    } else if (isoFile) {
      const name = isoFile.name.toLowerCase();
      if (name.endsWith(".iso")) {
        config.cdrom = { buffer: isoFile };
      } else if (name.endsWith(".img")) {
        // For KolibriOS and other floppy/disk images
        config.fda = { buffer: isoFile };
      } else {
        config.hda = { buffer: isoFile };
      }
    }
    if (stateBuffer) {
      config.initial_state = { buffer: stateBuffer };
    }

    emulator = new V86Constructor(config);

    console.log('[v86] Emulator instance created successfully');

    emulator.add_listener("emulator-ready", function() {
      console.log('[v86] emulator-ready — VM is active. Starting execution...');
      emulator.run();
      hud.style.opacity = '0';
      setTimeout(function() { hud.style.display = 'none'; }, 500);
      
      statState.textContent = 'RUNNING';
      statState.classList.add('active');
      globalStatusText.textContent = 'ONLINE';
      btnPause.disabled = false;
      btnSaveState.disabled = false;
      btnReset.disabled = false;
      btnFullscreen.disabled = false;

      // Hack: Automatically boot Android by pressing enter
      const isAndroid = (isoFile && isoFile.name.toLowerCase().includes("android")) || 
                        (presetSelect && presetSelect.value && presetSelect.value.toLowerCase().includes("android"));
      if (isAndroid) {
        setTimeout(function() {
          if (emulator) {
            console.log('[v86] Automatically pressing Enter to boot Android...');
            emulator.keyboard_send_text("\n");
          }
        }, 3000);
      }

      // Enable Pointer Lock on clicking the screen container so cursor doesn't wander off-screen
      const container = document.getElementById("screen_container");
      container.addEventListener("click", function() {
        if (emulator && typeof emulator.lock_mouse === "function") {
          emulator.lock_mouse();
        }
      });
    });

    emulator.add_listener("screen-set-mode", function() {
      console.log('[v86] screen-set-mode — display mode changed');
    });

    // Log all boot/system text output directly to the browser console and serial drawer
    let serialLog = "";
    const serialBody = document.getElementById("serial-body");
    emulator.add_listener("serial0-output", function(char) {
      if (serialBody) {
        if (char !== "\r") {
          serialBody.textContent += char;
          // Cap console output buffer at 30,000 characters to prevent memory leaks
          if (serialBody.textContent.length > 30000) {
            serialBody.textContent = serialBody.textContent.substring(serialBody.textContent.length - 15000);
          }
          // Auto-scroll to bottom
          serialBody.scrollTop = serialBody.scrollHeight;
        }
      }

      if (char === "\n") {
        console.log("[v86 serial]", serialLog);
        serialLog = "";
      } else if (char !== "\r") {
        serialLog += char;
      }
    });

  } catch (err) {
    console.error('[v86] Fatal:', err);
    hudSpinner.style.display = 'none';
    hudMessage.innerHTML = '<strong style="color:#ff3b69">EMULATOR FATAL ERROR</strong>' + err.message;
    globalStatusText.textContent = 'ERROR';
    globalStatusDot.style.backgroundColor = '#ff3b69';
  }
});

// ── Pause / Resume ──
var isPaused = false;
btnPause.addEventListener('click', async function() {
  if (!emulator) return;
  if (isPaused) {
    emulator.run();
    btnPause.textContent = 'Pause';
    statState.textContent = 'RUNNING';
    globalStatusText.textContent = 'ONLINE';
    isPaused = false;
  } else {
    emulator.stop();
    btnPause.textContent = 'Resume';
    statState.textContent = 'PAUSED';
    globalStatusText.textContent = 'SUSPENDED';
    isPaused = true;
    
    // Auto-save state when paused
    await triggerAutoSave();
  }
});

// ── Save State (Manual Download) ──
btnSaveState.addEventListener('click', async function() {
  if (!emulator) return;
  btnSaveState.disabled = true;
  hudSpinner.style.display = 'block';
  hudMessage.innerHTML = '<strong>SAVING SYSTEM STATE</strong>Serializing memory pages & JIT cache...';
  hud.style.display = 'flex';
  hud.style.opacity = '1';

  console.log('[v86] Saving state...');
  try {
    const state = await emulator.save_state();
    console.log('[v86] State saved successfully. Size:', state.byteLength);

    const blob = new Blob([state], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "webvm_state.bin";
    a.click();

    // Auto-save to local IndexedDB too
    let displayName = "vm_session";
    if (isoFile) {
      displayName = isoFile.name;
    } else if (presetSelect && presetSelect.value) {
      displayName = presetSelect.value.substring(presetSelect.value.lastIndexOf('/') + 1);
    }
    await saveSessionToDB(state, displayName);

    hudSpinner.style.display = 'none';
    hudMessage.innerHTML = '<strong>STATE SAVED SUCCESSFULLY</strong>Downloaded & saved to IndexedDB.';
    setTimeout(() => {
      hud.style.opacity = '0';
      setTimeout(() => { hud.style.display = 'none'; }, 500);
    }, 1500);
  } catch (err) {
    console.error('[v86] Failed to save state:', err);
    hudSpinner.style.display = 'none';
    hudMessage.innerHTML = '<strong style="color:#ff3b69">SAVE STATE FAILED</strong>' + err.message;
    setTimeout(() => {
      hud.style.opacity = '0';
      setTimeout(() => { hud.style.display = 'none'; }, 500);
    }, 3000);
  } finally {
    btnSaveState.disabled = false;
  }
});

// ── Reset ──
btnReset.addEventListener('click', function() {
  if (emulator && confirm('Reboot the virtual machine?')) {
    emulator.restart();
  }
});

// ── Fullscreen ──
btnFullscreen.addEventListener('click', function() {
  var c = document.getElementById("screen_container");
  (c.requestFullscreen || c.webkitRequestFullscreen || c.mozRequestFullScreen || c.msRequestFullscreen).call(c);
});

// ── Collapsible Serial Console Actions ──
const btnToggleSerial = document.getElementById("btn-toggle-serial");
const btnClearSerial  = document.getElementById("btn-clear-serial");
const serialDrawer    = document.getElementById("serial-drawer");

if (btnToggleSerial && serialDrawer) {
  const toggleAction = function(e) {
    e.stopPropagation();
    if (serialDrawer.classList.contains("expanded")) {
      serialDrawer.classList.remove("expanded");
      btnToggleSerial.textContent = "Expand";
    } else {
      serialDrawer.classList.add("expanded");
      btnToggleSerial.textContent = "Collapse";
    }
  };

  btnToggleSerial.addEventListener("click", toggleAction);
  document.getElementById("serial-header").addEventListener("click", toggleAction);
}

if (btnClearSerial && serialBody) {
  btnClearSerial.addEventListener("click", function(e) {
    e.stopPropagation();
    serialBody.textContent = "";
  });
}

// ── Drag & Drop File Injection (Auto-Typing) ──
const screenBody = document.querySelector(".screen-body");
if (screenBody) {
  ["dragenter", "dragover", "dragleave", "drop"].forEach(eventName => {
    screenBody.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });

  screenBody.addEventListener("drop", function(e) {
    const file = e.dataTransfer.files[0];
    if (!file || !emulator) return;

    hud.style.display = 'flex';
    hud.style.opacity = '1';
    hudSpinner.style.display = 'block';
    hudMessage.innerHTML = `<strong>READING DRAGGED FILE</strong>Reading ${file.name}...`;

    const reader = new FileReader();
    reader.onload = async function(evt) {
      const content = evt.target.result;
      hudMessage.innerHTML = `<strong>INJECTING FILE</strong>Typing <code>${file.name}</code> into active window...`;
      
      try {
        // If it is a Linux preset/OS, write the file using EOF cat command directly into shell
        let isLinux = false;
        if (isoFile && (isoFile.name.toLowerCase().includes("tinycore") || isoFile.name.toLowerCase().includes("slitaz") || isoFile.name.toLowerCase().includes("dsl"))) {
          isLinux = true;
        } else if (presetSelect && presetSelect.value && (presetSelect.value.includes("TinyCore") || presetSelect.value.includes("slitaz") || presetSelect.value.includes("dsl"))) {
          isLinux = true;
        }

        if (isLinux) {
          // Linux Shell write block (fast and creates file natively in path)
          const command = `\ncat << 'EOF' > ${file.name}\n${content}\nEOF\n`;
          await emulator.keyboard_send_text(command, 4);
        } else {
          // Fallback raw typing (simulates standard key presses, works anywhere)
          await emulator.keyboard_send_text(content, 12);
        }

        hudSpinner.style.display = 'none';
        hudMessage.innerHTML = `<strong>INJECTION COMPLETED</strong>Successfully created <code>${file.name}</code> in VM!`;
        setTimeout(() => {
          hud.style.opacity = '0';
          setTimeout(() => { hud.style.display = 'none'; }, 500);
        }, 1500);
      } catch (err) {
        console.error("[VM Injection] Keyboard write failed:", err);
        hudSpinner.style.display = 'none';
        hudMessage.innerHTML = `<strong style="color:var(--red)">INJECTION FAILED</strong>` + err.message;
        setTimeout(() => {
          hud.style.opacity = '0';
          setTimeout(() => { hud.style.display = 'none'; }, 500);
        }, 3000);
      }
    };

    reader.onerror = function() {
      hudSpinner.style.display = 'none';
      hudMessage.innerHTML = `<strong style="color:var(--red)">READ ERROR</strong>Failed to parse file.`;
      setTimeout(() => {
        hud.style.opacity = '0';
        setTimeout(() => { hud.style.display = 'none'; }, 500);
      }, 2000);
    };

    reader.readAsText(file);
  });
}

// Check database on page load to enable/disable resume button
updateRestoreButton();