// WebXR Spatial Notes Prototype (Three.js ES module via CDN or bundle)
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

let xrSession = null;
let renderer, scene, camera;
let hitTestSource = null;
let hitTestSourceRequested = false;

let reticle;
let currentMode = 'pin'; // 'pin' or 'draw'
let currentColor = '#ff3b30';

let placedObjects = [];
let pendingHitPose = null;
let isDrawing = false;
let currentLine = null;
let linePoints = [];

// DOM Elements
const fallbackScreen = document.getElementById('fallback-screen');
const arOverlay = document.getElementById('ar-overlay');
const webxrStatus = document.getElementById('webxr-status');
const startArBtn = document.getElementById('start-ar-btn');
const exitArBtn = document.getElementById('exit-ar-btn');
const trackingText = document.getElementById('tracking-text');
const trackingBadge = document.getElementById('tracking-badge');
const noteModal = document.getElementById('note-modal');
const noteTextInput = document.getElementById('note-text-input');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');
const undoBtn = document.getElementById('undo-btn');

// Mode Buttons
const modePinBtn = document.getElementById('mode-pin-btn');
const modeDrawBtn = document.getElementById('mode-draw-btn');
const colorSwatches = document.querySelectorAll('.color-swatch');

init();

async function init() {
  checkWebXRSupport();
  setupUIEventListeners();
}

async function checkWebXRSupport() {
  if ('xr' in navigator) {
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (supported) {
      webxrStatus.textContent = '✅ WebXR (immersive-ar) wird auf diesem Gerät unterstützt!';
      webxrStatus.style.color = '#30d158';
      startArBtn.disabled = false;
    } else {
      webxrStatus.textContent = '❌ WebXR AR wird auf diesem Browser/Gerät nicht unterstützt.';
      webxrStatus.style.color = '#ff453a';
    }
  } else {
    webxrStatus.textContent = '❌ WebXR API nicht im Browser verfügbar.';
    webxrStatus.style.color = '#ff453a';
  }
}

function setupUIEventListeners() {
  startArBtn.addEventListener('click', startAR);
  exitArBtn.addEventListener('click', endAR);

  modePinBtn.addEventListener('click', () => setMode('pin'));
  modeDrawBtn.addEventListener('click', () => setMode('draw'));

  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      currentColor = swatch.dataset.color;
    });
  });

  modalCancelBtn.addEventListener('click', () => {
    noteModal.classList.add('hidden');
    pendingHitPose = null;
  });

  modalSaveBtn.addEventListener('click', createNotePin);

  undoBtn.addEventListener('click', undoLastAction);
}

function setMode(mode) {
  currentMode = mode;
  if (mode === 'pin') {
    modePinBtn.classList.add('active');
    modeDrawBtn.classList.remove('active');
    if (reticle) reticle.visible = true;
  } else {
    modeDrawBtn.classList.add('active');
    modePinBtn.classList.remove('active');
    if (reticle) reticle.visible = false;
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

  // Lighting
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  scene.add(light);

  // Reticle
  const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x0a84ff, side: THREE.DoubleSide });
  reticle = new THREE.Mesh(ringGeo, ringMat);
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

    renderer.setAnimationLoop(render);
  } catch (e) {
    console.error('AR session start failed:', e);
    alert('Fehler beim Starten der AR-Session: ' + e.message);
  }
}

function onSessionEnded() {
  hitTestSourceRequested = false;
  hitTestSource = null;
  xrSession = null;
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

function onSelectStart() {
  if (currentMode === 'pin' && reticle.visible) {
    pendingHitPose = reticle.matrix.clone();
    noteTextInput.value = '';
    noteModal.classList.remove('hidden');
    noteTextInput.focus();
  } else if (currentMode === 'draw') {
    isDrawing = true;
    linePoints = [];
    createNewLine();
  }
}

function onSelectEnd() {
  if (currentMode === 'draw') {
    isDrawing = false;
    currentLine = null;
  }
}

function createNotePin() {
  const text = noteTextInput.value.trim() || 'Notiz';
  noteModal.classList.add('hidden');
  if (!pendingHitPose) return;

  const pinGroup = new THREE.Group();
  pinGroup.matrix.copy(pendingHitPose);
  pinGroup.matrix.decompose(pinGroup.position, pinGroup.quaternion, pinGroup.scale);

  // Pin marker mesh
  const pinGeo = new THREE.ConeGeometry(0.03, 0.1, 16).rotateX(Math.PI);
  const pinMat = new THREE.MeshStandardMaterial({ color: currentColor });
  const pinMesh = new THREE.Mesh(pinGeo, pinMat);
  pinMesh.position.y = 0.05;
  pinGroup.add(pinMesh);

  // Canvas Note Texture
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1c1c1e';
  ctx.fillRect(0, 0, 512, 256);
  ctx.lineWidth = 8;
  ctx.strokeStyle = currentColor;
  ctx.strokeRect(4, 4, 504, 248);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 128);

  const texture = new THREE.CanvasTexture(canvas);
  const labelGeo = new THREE.PlaneGeometry(0.25, 0.125);
  const labelMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.y = 0.18;
  pinGroup.add(labelMesh);

  scene.add(pinGroup);
  placedObjects.push(pinGroup);
  pendingHitPose = null;
}

function createNewLine() {
  const material = new THREE.LineBasicMaterial({
    color: currentColor,
    linewidth: 5
  });
  const geometry = new THREE.BufferGeometry();
  currentLine = new THREE.Line(geometry, material);
  scene.add(currentLine);
  placedObjects.push(currentLine);
}

function updateLine() {
  if (!currentLine || !renderer.xr.isPresenting) return;
  const controller = renderer.xr.getController(0);
  const pos = new THREE.Vector3();
  controller.getWorldPosition(pos);
  linePoints.push(pos.x, pos.y, pos.z);

  const floatArray = new Float32Array(linePoints);
  currentLine.geometry.setAttribute('position', new THREE.BufferAttribute(floatArray, 3));
  currentLine.geometry.attributes.position.needsUpdate = true;
}

function undoLastAction() {
  if (placedObjects.length > 0) {
    const lastObj = placedObjects.pop();
    scene.remove(lastObj);
  }
}

function render(timestamp, frame) {
  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    if (!hitTestSourceRequested) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
        });
      });
      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });
      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);

        if (currentMode === 'pin') {
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
        }
        trackingText.textContent = 'Fläche erkannt';
        trackingBadge.className = 'badge success';
      } else {
        if (currentMode === 'pin') reticle.visible = false;
        trackingText.textContent = 'Suche Fläche...';
        trackingBadge.className = 'badge warning';
      }
    }
  }

  if (isDrawing) {
    updateLine();
  }

  renderer.render(scene, camera);
}
