declare module 'three/addons/webxr/ARButton.js' {
  import { WebGLRenderer } from 'three';

  export class ARButton {
    static createButton(renderer: WebGLRenderer, sessionInit?: XRSessionInit): HTMLElement;
  }
}

declare module 'three/addons/loaders/GLTFLoader.js' {
  export * from 'three/examples/jsm/loaders/GLTFLoader.js';
}

declare module 'three/addons/loaders/DRACOLoader.js' {
  export * from 'three/examples/jsm/loaders/DRACOLoader.js';
}
