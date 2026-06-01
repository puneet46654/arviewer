'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';

type ViewerStatus =
  | 'checking'
  | 'loading'
  | 'ready'
  | 'scanning'
  | 'placed'
  | 'ios-available'
  | 'unsupported'
  | 'error';

type ProfessionalARViewerProps = {
  modelUrl: string;
  iosModelUrl?: string;
  iosPreviewImageUrl?: string;
};

type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controller: any;
  reticle: THREE.Mesh;
  modelGroup: THREE.Group;
  shadowPlane: THREE.Mesh;
  dracoLoader: any;
  arButton: HTMLElement | null;
};

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.5;
const SCALE_STEP = 0.1;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function importThreeModules(modulesRef: any) {
  if (modulesRef.current) return modulesRef.current;

  const [THREE, { GLTFLoader }, { DRACOLoader }, { ARButton }] = await Promise.all([
    import('three'),
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/webxr/ARButton.js'),
  ]);

  modulesRef.current = { THREE, GLTFLoader, DRACOLoader, ARButton };
  return modulesRef.current;
}

function cleanModelForAR(root: any, THREE: any) {
  const removeList: any[] = [];

  root.updateMatrixWorld(true);

  root.traverse((child: any) => {
    const name = (child.name || '').toLowerCase();

    const isNamedBackdrop =
      name === 'gg' ||
      name.includes('background') ||
      name.includes('backdrop') ||
      name.includes('floor_plane') ||
      name.includes('floorplane') ||
      name.includes('environment');

    if (child.parent && isNamedBackdrop) {
      removeList.push(child);
    }

    if (!(child instanceof Object) || !(child.isMesh || child.type === 'Mesh')) return;

    child.castShadow = false;
    child.receiveShadow = false;
    child.frustumCulled = true;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    materials.forEach((material: any) => {
      if (material) {
        material.side = THREE.FrontSide;
        material.needsUpdate = true;
      }
    });
  });

  removeList.forEach((object) => {
    object.parent?.remove(object);
  });
}

function normalizeModelToGround(root: any, THREE: any) {
  const box = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();

  box.getCenter(center);

  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
}

function isIosDevice() {
  const ua = navigator.userAgent || '';

  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isIosInAppBrowser() {
  const ua = navigator.userAgent || '';

  return (
    isIosDevice() &&
    /FBAN|FBAV|Instagram|Twitter|LinkedIn|Line|WhatsApp|Snapchat|Telegram|WeChat|Teams/i.test(ua)
  );
}

function resolveAbsoluteUrl(url: string) {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return url;
  }
}

function stripQueryAndHash(url: string) {
  return url.split(/[?#]/)[0] ?? url;
}

function replaceModelExtension(url: string, extension: 'usdz' | 'reality') {
  const match = url.match(/^([^?#]+)([?#].*)?$/);
  const path = match?.[1] ?? url;
  const suffix = match?.[2] ?? '';

  const nextPath = /\.[^/.]+$/.test(path)
    ? path.replace(/\.[^/.]+$/, `.${extension}`)
    : `${path}.${extension}`;

  return `${nextPath}${suffix}`;
}

function getIosQuickLookCandidates(modelUrl: string, iosModelUrl?: string) {
  const candidates: string[] = [];

  if (iosModelUrl) {
    candidates.push(iosModelUrl);
  }

  const modelPath = stripQueryAndHash(modelUrl);

  if (/\.(usdz|reality)$/i.test(modelPath)) {
    candidates.push(modelUrl);
  }

  candidates.push(replaceModelExtension(modelUrl, 'usdz'));
  candidates.push(replaceModelExtension(modelUrl, 'reality'));

  return [...new Set(candidates)].map(resolveAbsoluteUrl);
}

function supportsQuickLookAR() {
  try {
    const anchor = document.createElement('a');
    return Boolean(anchor.relList?.supports?.('ar'));
  } catch {
    return false;
  }
}

async function urlExists(url: string) {
  try {
    const head = await fetch(url, { method: 'HEAD' });

    if (head.ok) {
      return true;
    }
  } catch {
    // Some hosts reject HEAD requests, fall back to a small GET request.
  }

  try {
    const rangeResponse = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });

    return rangeResponse.ok;
  } catch {
    return false;
  }
}

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value && typeof value === 'object' && 'isTexture' in value) {
      (value as THREE.Texture).dispose();
    }
  });

  material.dispose();
}

export default function ProfessionalARViewer({
  modelUrl,
  iosModelUrl,
  iosPreviewImageUrl = '/ssilogo.png',
}: ProfessionalARViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs | null>(null);
  const modulesRef = useRef<any>(null);

  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const hitTestSourceRequestedRef = useRef(false);

  const modelPlacedRef = useRef(false);
  const modelLoadedRef = useRef(false);
  const scaleRef = useRef(DEFAULT_SCALE);

  const [status, setStatus] = useState<ViewerStatus>('checking');
  const [progress, setProgress] = useState(0);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [iosFallbackUrl, setIosFallbackUrl] = useState<string | null>(null);

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'checking':
        return 'System Check';
      case 'loading':
        return 'Loading Model';
      case 'ready':
        return 'Ready';
      case 'scanning':
        return 'Scan Surface';
      case 'placed':
        return 'Model Locked';
      case 'ios-available':
        return 'iPhone AR Ready';
      case 'unsupported':
        return 'Unsupported';
      case 'error':
        return 'Error';
      default:
        return 'AR Viewer';
    }
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    let removeResizeListener: (() => void) | null = null;
    let removeControllerListener: (() => void) | null = null;

    async function setup() {
      const mount = mountRef.current;
      if (!mount) return;

      setErrorMessage(null);
      setIosFallbackUrl(null);
      setProgress(0);
      setStatus('checking');

      if (isIosDevice()) {
        const candidates = getIosQuickLookCandidates(modelUrl, iosModelUrl);

        for (const candidate of candidates) {
          if (await urlExists(candidate)) {
            if (cancelled) return;

            setIosFallbackUrl(candidate);
            setStatus('ios-available');

            if (!supportsQuickLookAR()) {
              setErrorMessage(
                'This browser may not support direct iPhone AR launch. Open this page in Safari if the button only downloads the model.'
              );
            } else if (isIosInAppBrowser()) {
              setErrorMessage(
                'If the AR viewer does not open here, use Safari. Some in-app browsers block Apple Quick Look AR.'
              );
            }

            return;
          }
        }

        if (cancelled) return;

        setErrorMessage(
          'iPhone AR needs a real .usdz or .reality model file. Add public/models/your-model.usdz, then keep iosModelUrl="/models/your-model.usdz".'
        );
        setStatus('error');
        return;
      }

      if (!('xr' in navigator) || !navigator.xr) {
        setStatus('unsupported');
        return;
      }

      try {
        const supported = await navigator.xr.isSessionSupported('immersive-ar');

        if (!supported) {
          setStatus('unsupported');
          return;
        }
      } catch {
        setStatus('unsupported');
        return;
      }

      if (cancelled) return;

      setStatus('loading');

      const { THREE, GLTFLoader, DRACOLoader, ARButton } = await importThreeModules(modulesRef);

      if (cancelled) return;

      const scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(
        70,
        window.innerWidth / window.innerHeight,
        0.01,
        50
      );

      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        powerPreference: 'high-performance',
      });

      renderer.setPixelRatio(1);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.domElement.style.position = 'fixed';
      renderer.domElement.style.top = '0';
      renderer.domElement.style.left = '0';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';

      try {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
      } catch {
        // Older Three.js versions may use a different color output property.
      }

      renderer.xr.enabled = true;
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      mount.appendChild(renderer.domElement);

      const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x445566, 2.2);
      scene.add(hemisphereLight);

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
      keyLight.position.set(2.5, 4, 3);
      scene.add(keyLight);

      const shadowPlane = new THREE.Mesh(
        new THREE.CircleGeometry(1.25, 32).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.22 })
      );

      shadowPlane.receiveShadow = true;
      shadowPlane.visible = false;
      scene.add(shadowPlane);

      const reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.18, 0.23, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: 0x0bd3d3,
          transparent: true,
          opacity: 0.95,
        })
      );

      reticle.matrixAutoUpdate = false;
      reticle.visible = false;
      scene.add(reticle);

      const modelGroup = new THREE.Group();
      modelGroup.visible = false;
      modelGroup.scale.setScalar(DEFAULT_SCALE);
      scene.add(modelGroup);

      const controller = renderer.xr.getController(0);
      scene.add(controller);

      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('/draco/');
      dracoLoader.setDecoderConfig({ type: 'wasm' });

      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);

      loader.load(
        modelUrl,
        (gltf: any) => {
          if (cancelled) return;

          const model = gltf.scene;

          cleanModelForAR(model, THREE);
          normalizeModelToGround(model, THREE);

          modelGroup.add(model);
          modelLoadedRef.current = true;

          setProgress(100);
          setStatus('ready');
        },
        (event: any) => {
          if (!event.total) return;

          const loaded = Math.round((event.loaded / event.total) * 100);
          setProgress(loaded);
        },
        (error: any) => {
          console.error(error);
          setErrorMessage(
            'The 3D model could not be loaded. Check the GLB path and Draco decoder files.'
          );
          setStatus('error');
        }
      );

      function placeModel() {
        if (!reticle.visible || !modelLoadedRef.current || modelPlacedRef.current) {
          return;
        }

        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const reticleScale = new THREE.Vector3();

        reticle.matrix.decompose(position, quaternion, reticleScale);

        modelGroup.position.copy(position);
        modelGroup.quaternion.copy(quaternion);
        modelGroup.scale.setScalar(scaleRef.current);
        modelGroup.visible = true;

        shadowPlane.position.copy(position);
        shadowPlane.quaternion.copy(quaternion);
        shadowPlane.visible = true;

        modelPlacedRef.current = true;
        reticle.visible = false;

        setStatus('placed');
      }

      controller.addEventListener('select', placeModel);

      removeControllerListener = () => {
        controller.removeEventListener('select', placeModel);
      };

      let arButton: HTMLElement | null = null;

      try {
        arButton = ARButton.createButton(renderer, {
          requiredFeatures: ['hit-test'],
        });

        if (arButton) {
          arButton.classList.add('ar-button');
          document.body.appendChild(arButton);
        }
      } catch {
        try {
          arButton = ARButton.createButton(renderer, {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay'],
            domOverlay: { root: document.body },
          });

          if (arButton) {
            arButton.classList.add('ar-button');
            document.body.appendChild(arButton);
          }
        } catch {
          setStatus('error');
          setErrorMessage(
            'Unable to initialize AR on this device. Ensure you are using a compatible browser and HTTPS.'
          );
        }
      }

      renderer.xr.addEventListener('sessionstart', () => {
        setStatus(modelPlacedRef.current ? 'placed' : 'scanning');
        renderer.setAnimationLoop(render);
      });

      renderer.xr.addEventListener('sessionend', () => {
        renderer.setAnimationLoop(null);
        hitTestSourceRef.current?.cancel?.();
        hitTestSourceRef.current = null;
        hitTestSourceRequestedRef.current = false;

        reticle.visible = false;

        setStatus(modelLoadedRef.current ? 'ready' : 'loading');
      });

      function render(_timestamp: number, frame?: XRFrame) {
        if (frame) {
          const session = renderer.xr.getSession();
          const referenceSpace = renderer.xr.getReferenceSpace();

          if (session && !hitTestSourceRequestedRef.current) {
            session
              .requestReferenceSpace('viewer')
              .then((viewerSpace: any) => {
                return session.requestHitTestSource?.({
                  space: viewerSpace,
                });
              })
              .then((source: any) => {
                if (source) {
                  hitTestSourceRef.current = source;
                }
              })
              .catch(() => {
                setStatus('error');
                setErrorMessage('Surface tracking could not be started.');
              });

            hitTestSourceRequestedRef.current = true;
          }

          if (
            hitTestSourceRef.current &&
            referenceSpace &&
            !modelPlacedRef.current
          ) {
            const hitTestResults = frame.getHitTestResults(hitTestSourceRef.current);

            if (hitTestResults.length > 0) {
              const pose = hitTestResults[0].getPose(referenceSpace);

              if (pose) {
                reticle.visible = true;
                reticle.matrix.fromArray(pose.transform.matrix);
              }
            } else {
              reticle.visible = false;
            }
          }
        }

        renderer.render(scene, camera);
      }

      function resize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }

      window.addEventListener('resize', resize);

      removeResizeListener = () => {
        window.removeEventListener('resize', resize);
      };

      refs.current = {
        renderer,
        scene,
        camera,
        controller,
        reticle,
        modelGroup,
        shadowPlane,
        dracoLoader,
        arButton,
      };
    }

    setup();

    return () => {
      cancelled = true;

      removeResizeListener?.();
      removeControllerListener?.();

      const current = refs.current;
      if (!current) return;

      current.renderer.setAnimationLoop(null);

      hitTestSourceRef.current?.cancel?.();
      hitTestSourceRef.current = null;
      hitTestSourceRequestedRef.current = false;

      current.arButton?.remove();
      current.renderer.domElement.remove();
      current.dracoLoader.dispose();

      current.scene.traverse((object: any) => {
        if (!object || (object.type !== 'Mesh' && !object.isMesh)) return;

        object.geometry.dispose();

        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];

        materials.forEach(disposeMaterial);
      });

      current.renderer.dispose();
      refs.current = null;
    };
  }, [modelUrl, iosModelUrl]);

  function updateScale(nextValue: number) {
    const nextScale = clamp(Number(nextValue.toFixed(2)), MIN_SCALE, MAX_SCALE);

    scaleRef.current = nextScale;
    setScale(nextScale);

    const modelGroup = refs.current?.modelGroup;

    if (modelGroup) {
      modelGroup.scale.setScalar(nextScale);
    }
  }

  function resetPlacement() {
    const current = refs.current;
    if (!current) return;

    modelPlacedRef.current = false;

    current.modelGroup.visible = false;
    current.reticle.visible = false;
    current.shadowPlane.visible = false;

    setStatus(current.renderer.xr.getSession() ? 'scanning' : 'ready');
  }

  const isLoading = status === 'loading' || status === 'checking';
  const isSessionActive = status === 'scanning' || status === 'placed';

  return (
    <main className="ar-shell">
      <div ref={mountRef} className="ar-canvas-root" />

      <div className="ar-topbar">
        <section className="ar-panel">
          <div className="ar-brand-header">
            <img src="/ssilogo.png" alt="Company Logo" className="brand-logo" />
            <h1>Room AR Viewer</h1>
          </div>
          <p>Move your phone slowly to scan the floor. Tap the marker once to place the model.</p>
        </section>

        <div className="ar-status" aria-live="polite">
          <span className="status-dot" />
          {statusLabel}
        </div>
      </div>

      {isSessionActive && (
        <section className="ar-bottom-panel">
          <div className="ar-controls">
            <button
              className="control-button"
              type="button"
              onClick={() => updateScale(scale - SCALE_STEP)}
              disabled={scale <= MIN_SCALE}
            >
              - Scale
            </button>

            <button
              className="control-button"
              type="button"
              onClick={() => updateScale(DEFAULT_SCALE)}
            >
              Actual Size
            </button>

            <button
              className="control-button"
              type="button"
              onClick={() => updateScale(scale + SCALE_STEP)}
              disabled={scale >= MAX_SCALE}
            >
              + Scale
            </button>

            <button
              className="control-button warning"
              type="button"
              onClick={resetPlacement}
              disabled={!modelPlacedRef.current}
            >
              Reposition
            </button>
          </div>

          <div className="ar-meta">
            <strong>Scale: {scale.toFixed(2)}x</strong>
            <span>Tap once to lock placement</span>
          </div>
        </section>
      )}

      {isLoading && (
        <div className="loading-screen">
          <section className="loading-card">
            <h2>
              {status === 'checking' ? 'System Check' : 'Loading 3D model'}
            </h2>
            <p>Keep the camera steady while the viewer prepares the model.</p>
            <div className="progress-track">
              <div
                className="progress-bar"
                style={{
                  width: `${status === 'checking' ? 24 : progress}%`,
                }}
              />
            </div>
          </section>
        </div>
      )}

      {status === 'ios-available' && iosFallbackUrl && (
        <div className="unsupported-screen">
          <section className="unsupported-card">
            <h2>iPhone AR Available</h2>

            <p>
              Tap the button below to open the model in Apple Quick Look for AR viewing.
            </p>

            {errorMessage && <p className="ios-note">{errorMessage}</p>}

<div className="ios-ar-button-wrap" role="button" aria-label="View in AR on iPhone">
  <a href={iosFallbackUrl} rel="ar" className="ios-ar-link">
    <img src={iosPreviewImageUrl} alt="View in AR on iPhone" />
  </a>

  <span className="ios-ar-label">View in AR on iPhone</span>
</div>
          </section>
        </div>
      )}

      {status === 'unsupported' && (
        <div className="unsupported-screen">
          <section className="unsupported-card">
            <h2>AR Not Available</h2>
            <p>Use Chrome on an ARCore-supported Android device. The page must be served through HTTPS.</p>
          </section>
        </div>
      )}

      {status === 'error' && (
        <div className="unsupported-screen">
          <section className="unsupported-card">
            <h2>Viewer Error</h2>
            <p>{errorMessage}</p>
          </section>
        </div>
      )}
    </main>
  );
}