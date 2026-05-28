'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

type ViewerStatus = 'checking' | 'loading' | 'ready' | 'scanning' | 'placed' | 'unsupported' | 'error';

type ProfessionalARViewerProps = {
  modelUrl: string;
};

type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controller: THREE.XRTargetRaySpace;
  reticle: THREE.Mesh;
  modelGroup: THREE.Group;
  dracoLoader: DRACOLoader;
  arButton: HTMLElement | null;
};

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.5;
const SCALE_STEP = 0.1;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function cleanModelForAR(root: THREE.Object3D) {
  const removeList: THREE.Object3D[] = [];
  const reusableBox = new THREE.Box3();
  const reusableSize = new THREE.Vector3();

  root.updateMatrixWorld(true);

  root.traverse((child) => {
    const name = child.name.toLowerCase();

    reusableBox.setFromObject(child);
    reusableBox.getSize(reusableSize);

    const isHugeFlatPlane = reusableSize.x > 5 && reusableSize.z > 5 && reusableSize.y < 0.25;
    const isNamedBackdrop =
      name === 'gg' ||
      name.includes('background') ||
      name.includes('backdrop') ||
      name.includes('floor_plane');

    // The uploaded GLB contains a very large backdrop/floor plane.
    // Remove only large backdrop-like objects so useful screen panels are not accidentally deleted.
    if (isNamedBackdrop || isHugeFlatPlane) {
      removeList.push(child);
    }
  });

  removeList.forEach((object) => object.parent?.remove(object));

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    child.castShadow = true;
    child.receiveShadow = true;

    const material = child.material;
    const materials = Array.isArray(material) ? material : [material];

    materials.forEach((mat) => {
      if ('side' in mat) mat.side = THREE.DoubleSide;
      if ('needsUpdate' in mat) mat.needsUpdate = true;
    });
  });
}

function normalizeModelToGround(root: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);

  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
}

export default function ProfessionalARViewer({ modelUrl }: ProfessionalARViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs | null>(null);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const hitTestSourceRequestedRef = useRef(false);
  const modelPlacedRef = useRef(false);
  const modelLoadedRef = useRef(false);
  const scaleRef = useRef(DEFAULT_SCALE);

  const [status, setStatus] = useState<ViewerStatus>('checking');
  const [progress, setProgress] = useState(0);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'checking':
        return 'Checking AR';
      case 'loading':
        return 'Loading model';
      case 'ready':
        return 'Ready';
      case 'scanning':
        return 'Scanning floor';
      case 'placed':
        return 'Model locked';
      case 'unsupported':
        return 'Not supported';
      case 'error':
        return 'Error';
      default:
        return 'AR';
    }
  }, [status]);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      const mount = mountRef.current;
      if (!mount) return;

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

      const scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.xr.enabled = true;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mount.appendChild(renderer.domElement);

      const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x556677, 2.2);
      scene.add(hemisphereLight);

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
      keyLight.position.set(2, 4, 3);
      keyLight.castShadow = true;
      scene.add(keyLight);

      const shadowPlane = new THREE.Mesh(
        new THREE.CircleGeometry(1.25, 64).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.22 })
      );
      shadowPlane.receiveShadow = true;
      shadowPlane.visible = false;
      scene.add(shadowPlane);

      const reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.18, 0.23, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x0bd3d3 })
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
        (gltf) => {
          if (cancelled) return;

          const model = gltf.scene;
          cleanModelForAR(model);
          normalizeModelToGround(model);

          modelGroup.add(model);
          modelLoadedRef.current = true;
          setProgress(100);
          setStatus('ready');
        },
        (event) => {
          if (!event.total) return;
          setProgress(Math.round((event.loaded / event.total) * 100));
        },
        (error) => {
          console.error(error);
          setErrorMessage('The GLB model could not be loaded. Check the model path and Draco decoder files.');
          setStatus('error');
        }
      );

      function placeModel() {
        if (!reticle.visible || !modelLoadedRef.current || modelPlacedRef.current) return;

        modelGroup.visible = true;
        modelGroup.matrixAutoUpdate = false;
        modelGroup.matrix.copy(reticle.matrix);
        modelGroup.scale.setScalar(scaleRef.current);

        shadowPlane.visible = true;
        shadowPlane.matrixAutoUpdate = false;
        shadowPlane.matrix.copy(reticle.matrix);

        modelPlacedRef.current = true;
        reticle.visible = false;
        setStatus('placed');
      }

      controller.addEventListener('select', placeModel);

      const arButton = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.body },
      });
      arButton.classList.add('ar-button');
      arButton.style.position = 'fixed';
      arButton.style.left = '50%';
      arButton.style.bottom = 'max(104px, calc(env(safe-area-inset-bottom) + 104px))';
      arButton.style.transform = 'translateX(-50%)';
      arButton.style.zIndex = '50';
      arButton.style.width = 'auto';
      arButton.style.border = '0';
      document.body.appendChild(arButton);

      renderer.xr.addEventListener('sessionstart', () => {
        if (modelPlacedRef.current) {
          setStatus('placed');
        } else {
          setStatus('scanning');
        }
      });

      renderer.xr.addEventListener('sessionend', () => {
        hitTestSourceRequestedRef.current = false;
        hitTestSourceRef.current = null;
        reticle.visible = false;
        setStatus(modelLoadedRef.current ? 'ready' : 'loading');
      });

      function render(_timestamp: number, frame?: XRFrame) {
        if (frame) {
          const session = renderer.xr.getSession();
          const referenceSpace = renderer.xr.getReferenceSpace();

          if (session && !hitTestSourceRequestedRef.current) {
            session.requestReferenceSpace('viewer').then((viewerSpace) => {
              session.requestHitTestSource?.({ space: viewerSpace })?.then((source) => {
                hitTestSourceRef.current = source;
              });
            });

            hitTestSourceRequestedRef.current = true;
          }

          if (hitTestSourceRef.current && referenceSpace && !modelPlacedRef.current) {
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

      renderer.setAnimationLoop(render);

      function resize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }

      window.addEventListener('resize', resize);

      refs.current = {
        renderer,
        scene,
        camera,
        controller,
        reticle,
        modelGroup,
        dracoLoader,
        arButton,
      };

      return () => {
        window.removeEventListener('resize', resize);
        controller.removeEventListener('select', placeModel);
      };
    }

    let cleanupExtra: (() => void) | undefined;
    setup().then((cleanup) => {
      cleanupExtra = cleanup;
    });

    return () => {
      cancelled = true;
      cleanupExtra?.();

      const current = refs.current;
      if (!current) return;

      current.renderer.setAnimationLoop(null);
      current.arButton?.remove();
      current.renderer.domElement.remove();
      current.dracoLoader.dispose();

      current.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });

      current.renderer.dispose();
      refs.current = null;
    };
  }, [modelUrl]);

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
    current.modelGroup.matrixAutoUpdate = true;
    current.reticle.visible = false;

    const shadowPlane = current.scene.children.find((child) => child instanceof THREE.Mesh && child.material instanceof THREE.ShadowMaterial);
    if (shadowPlane) shadowPlane.visible = false;

    setStatus(current.renderer.xr.getSession() ? 'scanning' : 'ready');
  }

  return (
    <main className="ar-shell">
      <div ref={mountRef} className="ar-canvas-root" />

      <div className="ar-topbar">
        <section className="ar-panel">
          <h1>Professional Room AR Viewer</h1>
          <p>
            Move your phone slowly to detect the floor. When the cyan ring appears, tap once to place and lock the model.
          </p>
        </section>

        <div className="ar-status" aria-live="polite">
          <span className="status-dot" />
          {statusLabel}
        </div>
      </div>

      <section className="ar-bottom-panel">
        <div className="ar-controls">
          <button className="control-button" type="button" onClick={() => updateScale(scale - SCALE_STEP)}>
            - Scale
          </button>
          <button className="control-button" type="button" onClick={() => updateScale(DEFAULT_SCALE)}>
            1:1 Size
          </button>
          <button className="control-button" type="button" onClick={() => updateScale(scale + SCALE_STEP)}>
            + Scale
          </button>
          <button className="control-button warning" type="button" onClick={resetPlacement}>
            Reposition
          </button>
        </div>

        <div className="ar-meta">
          <strong>Scale: {scale.toFixed(2)}x</strong>
          <span>Background plane removed automatically</span>
        </div>
      </section>

      {(status === 'loading' || status === 'checking') && (
        <div className="loading-screen">
          <section className="loading-card">
            <h2>{status === 'checking' ? 'Checking AR support' : 'Preparing 3D model'}</h2>
            <p>Keep the model at real-world scale for accurate room placement.</p>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${status === 'checking' ? 24 : progress}%` }} />
            </div>
          </section>
        </div>
      )}

      {status === 'unsupported' && (
        <div className="unsupported-screen">
          <section className="unsupported-card">
            <h2>AR is not available on this device/browser</h2>
            <p>
              Use Chrome on an ARCore-supported Android phone and open this page through HTTPS. For iPhone support, export the
              model to USDZ and use Quick Look or model-viewer fallback.
            </p>
          </section>
        </div>
      )}

      {status === 'error' && (
        <div className="unsupported-screen">
          <section className="unsupported-card">
            <h2>Unable to load AR model</h2>
            <p>{errorMessage}</p>
          </section>
        </div>
      )}
    </main>
  );
}
