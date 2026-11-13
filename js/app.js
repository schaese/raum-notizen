import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const STORAGE_KEY = 'raum_notizen_scene_v1';

let xrSession = null;
let renderer, scene, camera;
let hitTestSource = null;
let hitTestSourceRequested = false;
let latestHitResult = null;

let reticle;
let currentMode = 'pin'; // 'pin' | 'draw' | 'measure'
let currentColor = '#ff3b30';

let placedObjects = [];
let activeAnchors = new Map(); // Map<XRAnchor, THREE.Object3D>
let billboardLabels = [];

// Pin creation / editing state
let pendingHitPose = null;
let pendingHitResult = null;
let editingPinGroup = null;

// 3D Drawing state
let isDrawing = false;
let currentStrokeGroup = null;
let lastDrawPoint = null;

// Measure state
let measureStartPoint = null;
let measurePreviewGroup = null;

let toastTimeout = null;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

// DOM Elements
const fallbackScreen = document.getElementById('fallback-screen');
const arOverlay = document.getElementById('ar-overlay');
const webxrStatus = document.getElementById('webxr-status');
const storageInfo = document.getElementById('storage-info');
const startArBtn = document.getElementById('start-ar-btn');
const exitArBtn = document.getElementById('exit-ar-btn');
const trackingText = document.getElementById('tracking-text');
const trackingBadge = document.getElementById('tracking-badge');
const toastMsg = document.getElementById('toast-msg');

const noteModal = document.getElementById('note-modal');
const modalTitle = document.getElementById('modal-title');
const noteTextInput = document.getElementById('note-text-input');
const micBtn = document.getElementById('mic-btn');
const modalDeleteBtn = document.getElementById('modal-delete-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');

const undoBtn = document.getElementById('undo-btn');
const saveSceneBtn = document.getElementById('save-scene-btn');
const loadSceneBtn = document.getElementById('load-scene-btn');
const clearAllBtn = document.getElementById('clear-all-btn');

const modePinBtn = document.getElementById('mode-pin-btn');
const modeDrawBtn = document.getElementById('mode-draw-btn');
const modeMeasureBtn = document.getElementById('mode-measure-btn');
const colorSwatches = document.querySelectorAll('.color-swatch');

init();

async function init() {
  updateStorageInfoBadge();
  await checkWebXRSupport();
  setupUIEventListeners();
  setupSpeechRecognition();
}

function showToast(text, duration = 2200) {
  if (!toastMsg) return;
  toastMsg.textContent = text;
  toastMsg.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastMsg.classList.add('hidden');
  }, duration);
}

function updateStorageInfoBadge() {
  if (!storageInfo) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    storageInfo.textContent = `Lokal gespeicherte Elemente: ${items.length}`;
  } catch (e) {
    storageInfo.textContent = 'Lokaler Speicher bereit';
  }
}

async function checkWebXRSupport() {
  if ('xr' in navigator) {
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      if (supported) {
        webxrStatus.textContent = '✅ WebXR (immersive-ar) wird auf diesem Gerät unterstützt!';
        webxrStatus.style.color = '#30d158';
        startArBtn.disabled = false;
      } else {
        webxrStatus.textContent = '❌ WebXR AR wird auf diesem Browser/Gerät nicht unterstützt.';
        webxrStatus.style.color = '#ff453a';
      }
    } catch (err) {
      webxrStatus.textContent = '❌ Fehler bei der WebXR-Prüfung (HTTPS aktiv?).';
      webxrStatus.style.color = '#ff453a';
    }
  } else {
    webxrStatus.textContent = '❌ WebXR API nicht im Browser verfügbar (HTTPS erforderlich).';
    webxrStatus.style.color = '#ff453a';
  }
}

function setupUIEventListeners() {
  // Block WebXR select events when interacting with DOM overlay UI
  document.querySelectorAll('.ui-interactive').forEach((el) => {
    el.addEventListener('beforexrselect', (e) => {
      e.preventDefault();
    });
  });

  startArBtn.addEventListener('click', startAR);
  exitArBtn.addEventListener('click', endAR);

  modePinBtn.addEventListener('click', () => setMode('pin'));
  modeDrawBtn.addEventListener('click', () => setMode('draw'));
  modeMeasureBtn.addEventListener('click', () => setMode('measure'));

  colorSwatches.forEach((swatch) => {
    swatch.addEventListener('click', () => {
      colorSwatches.forEach((s) => s.classList.remove('active'));
      swatch.classList.add('active');
      currentColor = swatch.dataset.color;
    });
  });

  modalCancelBtn.addEventListener('click', closeNoteModal);
  modalSaveBtn.addEventListener('click', saveNoteModal);
  modalDeleteBtn.addEventListener('click', deleteSelectedPin);

  undoBtn.addEventListener('click', undoLastAction);
  saveSceneBtn.addEventListener('click', () => saveSceneToLocalStorage(true));
  loadSceneBtn.addEventListener('click', () => loadSceneFromLocalStorage(true));
  clearAllBtn.addEventListener('click', clearAllObjects);
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.style.display = 'none';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'de-DE';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  micBtn.addEventListener('click', () => {
    try {
      recognition.start();
      micBtn.classList.add('recording');
    } catch (e) {
      recognition.stop();
    }
  });

  recognition.addEventListener('result', (e) => {
    const transcript = e.results[0][0].transcript;
    noteTextInput.value = transcript.slice(0, 80);
  });

  recognition.addEventListener('end', () => {
    micBtn.classList.remove('recording');
  });
}

function setMode(mode) {
  currentMode = mode;
  measureStartPoint = null;
  if (measurePreviewGroup) {
    disposeObject3D(measurePreviewGroup);
    scene.remove(measurePreviewGroup);
    measurePreviewGroup = null;
  }

  modePinBtn.classList.toggle('active', mode === 'pin');
  modeDrawBtn.classList.toggle('active', mode === 'draw');
  modeMeasureBtn.classList.toggle('active', mode === 'measure');

  if (reticle) {
    reticle.visible = (mode === 'pin' || mode === 'measure') && latestHitResult !== null;
  }
}

async function startAR() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.2);
  scene.add(light);

  // Reticle with center dot
  const reticleGroup = new THREE.Group();
  const ringGeo = new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x0a84ff, side: THREE.DoubleSide });
  const dotGeo = new THREE.CircleGeometry(0.015, 16).rotateX(-Math.PI / 2);
  reticleGroup.add(new THREE.Mesh(ringGeo, ringMat));
  reticleGroup.add(new THREE.Mesh(dotGeo, ringMat));

  reticle = reticleGroup;
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors'],
      domOverlay: { root: arOverlay }
    });

    xrSession.addEventListener('end', onSessionEnded);
    xrSession.addEventListener('selectstart', onSelectStart);
    xrSession.addEventListener('selectend', onSelectEnd);

    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(xrSession);

    fallbackScreen.classList.add('hidden');
    arOverlay.classList.remove('hidden');

    // Automatically restore saved elements if available
    loadSceneFromLocalStorage(false);

    renderer.setAnimationLoop(render);
  } catch (e) {
    console.error('AR session start failed:', e);
    alert('Fehler beim Starten der AR-Session: ' + e.message);
  }
}

function onSessionEnded() {
  hitTestSourceRequested = false;
  hitTestSource = null;
  latestHitResult = null;
  xrSession = null;
  activeAnchors.clear();
  billboardLabels = [];
  placedObjects = [];
  updateStorageInfoBadge();

  fallbackScreen.classList.remove('hidden');
  arOverlay.classList.add('hidden');
  if (renderer && renderer.domElement) {
    document.body.removeChild(renderer.domElement);
  }
}

function endAR() {
  if (xrSession) {
    xrSession.end();
  }
}

function onSelectStart(event) {
  if (!noteModal.classList.contains('hidden')) return;

  if (currentMode === 'pin') {
    // 1. Check if user tapped an existing pin via Raycaster
    const hitPin = checkPinIntersection(event.inputSource);
    if (hitPin) {
      openEditModal(hitPin);
      return;
    }

    // 2. Otherwise place new pin at reticle
    if (reticle.visible) {
      editingPinGroup = null;
      pendingHitPose = reticle.matrix.clone();
      pendingHitResult = latestHitResult;
      modalTitle.textContent = 'Notiz an Pin anheften';
      noteTextInput.value = '';
      modalDeleteBtn.classList.add('hidden');
      noteModal.classList.remove('hidden');
      noteTextInput.focus();
    }
  } else if (currentMode === 'draw') {
    isDrawing = true;
    lastDrawPoint = null;
    currentStrokeGroup = new THREE.Group();
    currentStrokeGroup.userData = {
      type: 'draw',
      color: currentColor,
      points: []
    };
    scene.add(currentStrokeGroup);
    placedObjects.push(currentStrokeGroup);
  } else if (currentMode === 'measure' && reticle.visible) {
    handleMeasureTap();
  }
}

function onSelectEnd() {
  if (currentMode === 'draw' && isDrawing) {
    isDrawing = false;
    if (currentStrokeGroup && currentStrokeGroup.userData.points.length > 1) {
      saveSceneToLocalStorage(false);
    }
    currentStrokeGroup = null;
    lastDrawPoint = null;
  }
}

function checkPinIntersection(inputSource) {
  const frame = renderer.xr.getFrame();
  const referenceSpace = renderer.xr.getReferenceSpace();
  if (!frame || !inputSource || !inputSource.targetRaySpace) return null;

  const rayPose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
  if (!rayPose) return null;

  tempMatrix.fromArray(rayPose.transform.matrix);
  raycaster.ray.origin.setFromMatrixPosition(tempMatrix);
  raycaster.ray.direction.set(0, 0, -1).transformDirection(tempMatrix);

  const pinGroups = placedObjects.filter((obj) => obj.userData && obj.userData.type === 'pin');
  const intersects = raycaster.intersectObjects(pinGroups, true);

  if (intersects.length > 0) {
    let obj = intersects[0].object;
    while (obj && (!obj.userData || obj.userData.type !== 'pin')) {
      obj = obj.parent;
    }
    return obj;
  }
  return null;
}

function openEditModal(pinGroup) {
  editingPinGroup = pinGroup;
  modalTitle.textContent = 'Notiz bearbeiten';
  noteTextInput.value = pinGroup.userData.text || '';
  modalDeleteBtn.classList.remove('hidden');
  noteModal.classList.remove('hidden');
  noteTextInput.focus();
}

function closeNoteModal() {
  noteModal.classList.add('hidden');
  pendingHitPose = null;
  pendingHitResult = null;
  editingPinGroup = null;
}

async function saveNoteModal() {
  const text = noteTextInput.value.trim() || 'Notiz';
  noteModal.classList.add('hidden');

  if (editingPinGroup) {
    updatePinAppearance(editingPinGroup, text, currentColor);
    editingPinGroup = null;
    saveSceneToLocalStorage(false);
    showToast('Notiz aktualisiert');
    return;
  }

  if (!pendingHitPose) return;

  const pinGroup = buildPinGroup(text, currentColor, pendingHitPose);
  scene.add(pinGroup);
  placedObjects.push(pinGroup);

  // Bind XRAnchor if supported by device/browser
  if (pendingHitResult && typeof pendingHitResult.createAnchor === 'function') {
    try {
      const anchor = await pendingHitResult.createAnchor();
      if (anchor) {
        activeAnchors.set(anchor, pinGroup);
        pinGroup.userData.anchor = anchor;
      }
    } catch (err) {
      console.warn('Anchor creation fallback to static pose:', err);
    }
  }

  saveSceneToLocalStorage(false);
  pendingHitPose = null;
  pendingHitResult = null;
}

function deleteSelectedPin() {
  if (!editingPinGroup) return;
  removeSpecificObject(editingPinGroup);
  closeNoteModal();
  saveSceneToLocalStorage(false);
  showToast('Pin gelöscht');
}

function buildPinGroup(text, color, hitMatrix) {
  const pinGroup = new THREE.Group();

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  hitMatrix.decompose(position, quaternion, scale);

  pinGroup.position.copy(position);
  pinGroup.userData = {
    type: 'pin',
    text,
    color,
    position: position.toArray(),
    quaternion: quaternion.toArray()
  };

  // Orient the cone & contact shadow along surface normal
  const surfaceGroup = new THREE.Group();
  surfaceGroup.quaternion.copy(quaternion);

  // Contact shadow disc on surface
  const shadowGeo = new THREE.CircleGeometry(0.04, 24).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.35,
    depthWrite: false
  });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.position.y = 0.002;
  surfaceGroup.add(shadowMesh);

  // Pin cone
  const pinGeo = new THREE.ConeGeometry(0.025, 0.09, 20).rotateX(Math.PI);
  const pinMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3 });
  const pinMesh = new THREE.Mesh(pinGeo, pinMat);
  pinMesh.position.y = 0.045;
  surfaceGroup.add(pinMesh);
  pinGroup.add(surfaceGroup);

  // Upright Billboard Label (always stays vertical in world space)
  const texture = createLabelTexture(text, color);
  const labelGeo = new THREE.PlaneGeometry(0.26, 0.13);
  const labelMat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.y = 0.18;
  pinGroup.add(labelMesh);

  pinGroup.userData.pinMesh = pinMesh;
  pinGroup.userData.labelMesh = labelMesh;
  billboardLabels.push(labelMesh);

  return pinGroup;
}

function updatePinAppearance(pinGroup, newText, newColor) {
  pinGroup.userData.text = newText;
  pinGroup.userData.color = newColor;

  if (pinGroup.userData.pinMesh) {
    pinGroup.userData.pinMesh.material.color.set(newColor);
  }
  if (pinGroup.userData.labelMesh) {
    const oldTex = pinGroup.userData.labelMesh.material.map;
    if (oldTex) oldTex.dispose();
    pinGroup.userData.labelMesh.material.map = createLabelTexture(newText, newColor);
    pinGroup.userData.labelMesh.material.needsUpdate = true;
  }
}

function createLabelTexture(text, borderColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Rounded card background
  ctx.fillStyle = 'rgba(28, 28, 30, 0.94)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(4, 4, 504, 248, 28);
  } else {
    ctx.rect(4, 4, 504, 248);
  }
  ctx.fill();

  ctx.lineWidth = 10;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  // Multi-line word wrap
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0] || '';

  for (let i = 1; i < words.length; i++) {
    const testLine = currentLine + ' ' + words[i];
    if (ctx.measureText(testLine).width < 450) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);

  const lineHeight = 42;
  const startY = 128 - ((lines.length - 1) * lineHeight) / 2;
  lines.slice(0, 4).forEach((line, idx) => {
    ctx.fillText(line, 256, startY + idx * lineHeight);
  });

  return new THREE.CanvasTexture(canvas);
}

function addStrokeSegment(strokeGroup, fromVec, toVec, color) {
  const dist = toVec.distanceTo(fromVec);
  if (dist <= 0.0001) return;

  const segGeo = new THREE.CylinderGeometry(0.004, 0.004, dist, 8);
  segGeo.translate(0, dist / 2, 0);
  segGeo.rotateX(Math.PI / 2);

  const segMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  const segment = new THREE.Mesh(segGeo, segMat);
  segment.position.copy(fromVec);
  segment.lookAt(toVec);

  strokeGroup.add(segment);
}

// 3D Drawing with real 3D cylinder segments 25cm in front of the camera
function updateDrawing() {
  if (!isDrawing || !currentStrokeGroup || !renderer.xr.isPresenting) return;

  const xrCam = renderer.xr.getCamera(camera);
  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);

  xrCam.getWorldPosition(pos);
  dir.applyQuaternion(xrCam.quaternion);
  // Offset 25cm in front of device screen
  pos.add(dir.multiplyScalar(0.25));

  if (!lastDrawPoint) {
    lastDrawPoint = pos.clone();
    currentStrokeGroup.userData.points.push(pos.toArray());
    return;
  }

  const dist = pos.distanceTo(lastDrawPoint);
  if (dist < 0.008) return; // Minimum 8mm movement filter

  addStrokeSegment(currentStrokeGroup, lastDrawPoint, pos, currentStrokeGroup.userData.color);
  currentStrokeGroup.userData.points.push(pos.toArray());
  lastDrawPoint.copy(pos);
}

function buildMeasurementGroup(startVec, endVec, color) {
  const group = new THREE.Group();
  group.userData = {
    type: 'measure',
    color,
    start: startVec.toArray(),
    end: endVec.toArray()
  };

  const dotGeo = new THREE.SphereGeometry(0.012, 16, 16);
  const dotMat = new THREE.MeshBasicMaterial({ color });

  const startDot = new THREE.Mesh(dotGeo, dotMat);
  startDot.position.copy(startVec);
  group.add(startDot);

  const endDot = new THREE.Mesh(dotGeo.clone(), dotMat.clone());
  endDot.position.copy(endVec);
  group.add(endDot);

  const distanceMeters = startVec.distanceTo(endVec);
  const rodGeo = new THREE.CylinderGeometry(0.003, 0.003, distanceMeters, 8);
  rodGeo.translate(0, distanceMeters / 2, 0);
  rodGeo.rotateX(Math.PI / 2);
  const rodMat = new THREE.MeshBasicMaterial({ color });
  const rod = new THREE.Mesh(rodGeo, rodMat);
  rod.position.copy(startVec);
  rod.lookAt(endVec);
  group.add(rod);

  const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
  const formattedDist = distanceMeters < 1
    ? `${(distanceMeters * 100).toFixed(1)} cm`
    : `${distanceMeters.toFixed(2)} m`;

  const tex = createLabelTexture(`📏 ${formattedDist}`, color);
  const labelGeo = new THREE.PlaneGeometry(0.18, 0.09);
  const labelMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.copy(midPoint);
  labelMesh.position.y += 0.06;
  group.add(labelMesh);
  billboardLabels.push(labelMesh);

  return group;
}

// AR Tape Measure Mode
function handleMeasureTap() {
  const hitPos = new THREE.Vector3();
  hitPos.setFromMatrixPosition(reticle.matrix);

  if (!measureStartPoint) {
    measureStartPoint = hitPos.clone();
    measurePreviewGroup = new THREE.Group();

    const dotGeo = new THREE.SphereGeometry(0.012, 16, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: currentColor });
    const startDot = new THREE.Mesh(dotGeo, dotMat);
    startDot.position.copy(measureStartPoint);
    measurePreviewGroup.add(startDot);

    scene.add(measurePreviewGroup);
    showToast('Startpunkt gesetzt – Zielpunkt antippen');
  } else {
    const endPoint = hitPos.clone();
    if (measurePreviewGroup) {
      disposeObject3D(measurePreviewGroup);
      scene.remove(measurePreviewGroup);
      measurePreviewGroup = null;
    }

    const fullMeasureGroup = buildMeasurementGroup(measureStartPoint, endPoint, currentColor);
    scene.add(fullMeasureGroup);
    placedObjects.push(fullMeasureGroup);

    measureStartPoint = null;
    saveSceneToLocalStorage(false);
  }
}

// LocalStorage Persistence (Save & Load)
function serializeScene() {
  const data = [];
  placedObjects.forEach((obj) => {
    const ud = obj.userData;
    if (!ud || !ud.type) return;

    if (ud.type === 'pin') {
      data.push({
        type: 'pin',
        text: ud.text,
        color: ud.color,
        position: obj.position.toArray(),
        quaternion: ud.quaternion || [0, 0, 0, 1]
      });
    } else if (ud.type === 'draw' && Array.isArray(ud.points) && ud.points.length > 1) {
      data.push({
        type: 'draw',
        color: ud.color,
        points: ud.points
      });
    } else if (ud.type === 'measure') {
      data.push({
        type: 'measure',
        color: ud.color,
        start: ud.start,
        end: ud.end
      });
    }
  });
  return data;
}

function saveSceneToLocalStorage(showFeedback = true) {
  try {
    const serialized = serializeScene();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    updateStorageInfoBadge();
    if (showFeedback) {
      showToast(`💾 ${serialized.length} Element(e) gespeichert`);
    }
  } catch (err) {
    console.error('Fehler beim Speichern in localStorage:', err);
    if (showFeedback) showToast('❌ Speicherfehler');
  }
}

function loadSceneFromLocalStorage(showFeedback = true) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      if (showFeedback) showToast('Keine gespeicherten Daten gefunden');
      return;
    }

    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) {
      if (showFeedback) showToast('Speicher ist leer');
      return;
    }

    // Clear current objects in scene without wiping localStorage
    while (placedObjects.length > 0) {
      const obj = placedObjects.pop();
      if (obj.userData && obj.userData.anchor) {
        activeAnchors.delete(obj.userData.anchor);
      }
      disposeObject3D(obj);
      scene.remove(obj);
    }

    items.forEach((item) => {
      if (item.type === 'pin') {
        const mat = new THREE.Matrix4();
        const pos = new THREE.Vector3().fromArray(item.position || [0, 0, -0.5]);
        const quat = new THREE.Quaternion().fromArray(item.quaternion || [0, 0, 0, 1]);
        mat.compose(pos, quat, new THREE.Vector3(1, 1, 1));
        const pinGroup = buildPinGroup(item.text || 'Notiz', item.color || '#ff3b30', mat);
        scene.add(pinGroup);
        placedObjects.push(pinGroup);
      } else if (item.type === 'draw' && Array.isArray(item.points) && item.points.length > 1) {
        const strokeGroup = new THREE.Group();
        strokeGroup.userData = {
          type: 'draw',
          color: item.color || '#ff3b30',
          points: item.points
        };
        for (let i = 1; i < item.points.length; i++) {
          const p1 = new THREE.Vector3().fromArray(item.points[i - 1]);
          const p2 = new THREE.Vector3().fromArray(item.points[i]);
          addStrokeSegment(strokeGroup, p1, p2, strokeGroup.userData.color);
        }
        scene.add(strokeGroup);
        placedObjects.push(strokeGroup);
      } else if (item.type === 'measure' && item.start && item.end) {
        const s = new THREE.Vector3().fromArray(item.start);
        const e = new THREE.Vector3().fromArray(item.end);
        const measureGroup = buildMeasurementGroup(s, e, item.color || '#ff3b30');
        scene.add(measureGroup);
        placedObjects.push(measureGroup);
      }
    });

    if (showFeedback) {
      showToast(`📂 ${items.length} Element(e) geladen`);
    } else if (items.length > 0) {
      showToast(`📂 ${items.length} gespeicherte Element(e) wiederhergestellt`);
    }
  } catch (err) {
    console.error('Fehler beim Laden aus localStorage:', err);
    if (showFeedback) showToast('❌ Fehler beim Laden');
  }
}

function removeSpecificObject(obj) {
  const index = placedObjects.indexOf(obj);
  if (index !== -1) placedObjects.splice(index, 1);

  if (obj.userData && obj.userData.anchor) {
    activeAnchors.delete(obj.userData.anchor);
    if (typeof obj.userData.anchor.delete === 'function') {
      obj.userData.anchor.delete();
    }
  }

  disposeObject3D(obj);
  scene.remove(obj);
}

function undoLastAction() {
  if (placedObjects.length > 0) {
    const lastObj = placedObjects.pop();
    if (lastObj.userData && lastObj.userData.anchor) {
      activeAnchors.delete(lastObj.userData.anchor);
    }
    disposeObject3D(lastObj);
    scene.remove(lastObj);
    saveSceneToLocalStorage(false);
    showToast('↩️ Rückgängig');
  }
}

function clearAllObjects() {
  while (placedObjects.length > 0) {
    const lastObj = placedObjects.pop();
    if (lastObj.userData && lastObj.userData.anchor) {
      activeAnchors.delete(lastObj.userData.anchor);
    }
    disposeObject3D(lastObj);
    scene.remove(lastObj);
  }
  localStorage.removeItem(STORAGE_KEY);
  updateStorageInfoBadge();
  showToast('🗑️ Szene & Speicher geleert');
}

function disposeObject3D(root) {
  root.traverse((child) => {
    const labelIdx = billboardLabels.indexOf(child);
    if (labelIdx !== -1) billboardLabels.splice(labelIdx, 1);

    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });
}

function render(timestamp, frame) {
  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();
    const viewerPose = frame.getViewerPose(referenceSpace);

    // Request hit-test source once per session
    if (!hitTestSourceRequested) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
        });
      });
      hitTestSourceRequested = true;
    }

    // Update anchored objects
    activeAnchors.forEach((obj, anchor) => {
      const anchorPose = frame.getPose(anchor.anchorSpace, referenceSpace);
      if (anchorPose) {
        obj.position.copy(anchorPose.transform.position);
        if (obj.userData) {
          obj.userData.position = obj.position.toArray();
        }
      }
    });

    // Check camera tracking quality & hit-test results
    if (!viewerPose || viewerPose.emulatedPosition) {
      reticle.visible = false;
      trackingText.textContent = 'Tracking verloren – langsam bewegen';
      trackingBadge.className = 'badge error';
    } else if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        latestHitResult = hitTestResults[0];
        const pose = latestHitResult.getPose(referenceSpace);

        if (currentMode === 'pin' || currentMode === 'measure') {
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
        }
        trackingText.textContent = 'Fläche erkannt';
        trackingBadge.className = 'badge success';
      } else {
        latestHitResult = null;
        reticle.visible = false;
        trackingText.textContent = 'Suche Fläche...';
        trackingBadge.className = 'badge warning';
      }
    }

    // Billboard rotation: keep note and measurement labels facing the user horizontally
    if (viewerPose && billboardLabels.length > 0) {
      const camPos = viewerPose.transform.position;
      billboardLabels.forEach((label) => {
        const worldPos = new THREE.Vector3();
        label.getWorldPosition(worldPos);
        label.lookAt(camPos.x, worldPos.y, camPos.z);
      });
    }
  }

  if (isDrawing) {
    updateDrawing();
  }

  renderer.render(scene, camera);
}
