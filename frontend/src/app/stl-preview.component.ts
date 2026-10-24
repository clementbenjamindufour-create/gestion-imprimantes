import { afterNextRender, Component, ElementRef, EventEmitter, inject, Input, NgZone, OnDestroy, Output, signal, ViewChild } from '@angular/core';
import type * as Three from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ApiService, LibraryFile } from './api.service';

const MAX_BYTES = 50 * 1024 * 1024;

@Component({
  selector: 'app-stl-preview',
  template: `
    <dialog #dialog class="stl-dialog" aria-labelledby="stl-title" (cancel)="dismiss($event)" (click)="backdrop($event)">
      <header class="stl-header">
        <div><span class="eyebrow">APERÇU STL</span><h2 id="stl-title">{{ file.filename }}</h2></div>
        <button class="text-button" autofocus (click)="closed.emit()">Fermer</button>
      </header>
      <div #surface class="stl-surface" [attr.aria-busy]="loading()">
        @if (loading()) { <div class="stl-status" role="status">Chargement de la pièce… {{ progress() }}</div> }
        @if (error()) { <div class="stl-status" role="alert">{{ error() }}</div> }
        @if (!started && !error()) {
          <div class="stl-status"><p>Ce fichier est volumineux. Son aperçu peut utiliser beaucoup de mémoire.</p>
            <button class="button" (click)="start()">Charger l’aperçu</button></div>
        }
      </div>
      <footer class="stl-footer">
        <p>Glisser : rotation · Molette / pincement : zoom · Clic droit / deux doigts : déplacement.</p>
        @if (dimensions()) { <p><strong>{{ dimensions() }}</strong><br>Unités STL : généralement des millimètres, sans unité garantie dans le fichier.</p> }
        <div class="form-actions"><button class="button secondary" (click)="reset()" [disabled]="!ready()">Recentrer</button>
          <a class="button secondary" [href]="api.downloadUrl(file.id)">Télécharger le STL</a></div>
      </footer>
    </dialog>
  `,
  styleUrl: './stl-preview.component.css',
})
export class StlPreviewComponent implements OnDestroy {
  @Input({ required: true }) file!: LibraryFile;
  @Output() readonly closed = new EventEmitter<void>();
  @ViewChild('dialog', { static: true }) private dialog!: ElementRef<HTMLDialogElement>;
  @ViewChild('surface', { static: true }) private surface!: ElementRef<HTMLDivElement>;
  readonly api = inject(ApiService);
  private zone = inject(NgZone);
  readonly loading = signal(false);
  readonly progress = signal('');
  readonly error = signal('');
  readonly dimensions = signal('');
  readonly ready = signal(false);
  started = false;
  private destroyed = false;
  private abort = new AbortController();
  private renderer?: Three.WebGLRenderer;
  private controls?: OrbitControls;
  private geometry?: Three.BufferGeometry;
  private material?: Three.MeshStandardMaterial;
  private grid?: Three.GridHelper;
  private observer?: ResizeObserver;
  private previousFocus = document.activeElement as HTMLElement | null;

  constructor() { afterNextRender(() => this.open()); }

  private open() {
    if (this.destroyed) return;
    this.dialog.nativeElement.showModal();
    if (this.file.size_bytes > MAX_BYTES) {
      this.error.set('Aperçu limité à 50 Mo pour préserver la mémoire du navigateur. Le fichier reste téléchargeable.');
    } else if (this.file.size_bytes <= 10 * 1024 * 1024) {
      void this.start();
    }
  }

  dismiss(event: Event) { event.preventDefault(); this.closed.emit(); }
  backdrop(event: MouseEvent) {
    if (event.target !== this.dialog.nativeElement) return;
    const rect = this.dialog.nativeElement.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.closed.emit();
  }
  reset() { this.controls?.reset(); }

  async start() {
    if (this.started) return;
    this.started = true;
    this.loading.set(true);
    try {
      const [THREE, { STLLoader }, { OrbitControls }] = await Promise.all([
        import('three'), import('three/addons/loaders/STLLoader.js'), import('three/addons/controls/OrbitControls.js'),
      ]);
      if (this.destroyed) return;
      try { this.renderer = new THREE.WebGLRenderer({ antialias: true }); }
      catch { throw new Error('L’aperçu nécessite WebGL 2. Essaie un navigateur récent avec l’accélération graphique activée.'); }
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const canvas = this.renderer.domElement;
      canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
      canvas.setAttribute('aria-label', 'Vue 3D de ' + this.file.filename);
      canvas.setAttribute('role', 'img');
      canvas.addEventListener('webglcontextlost', this.contextLost);
      this.surface.nativeElement.appendChild(canvas);

      const response = await fetch(this.api.downloadUrl(this.file.id), { signal: this.abort.signal });
      if (!response.ok) throw new Error('Impossible de récupérer le fichier STL. Ferme l’aperçu puis réessaie.');
      const buffer = await this.readFile(response);
      if (this.destroyed) return;
      // Verifie les en-tetes avant que le chargeur alloue ses tableaux.
      const invalid = 'Le fichier STL est vide, invalide ou trop complexe pour être affiché.';
      if (buffer.byteLength < 84) throw new Error(invalid);
      const triangles = new DataView(buffer).getUint32(80, true);
      const binary = 84 + triangles * 50 === buffer.byteLength;
      const header = new TextDecoder().decode(buffer.slice(0, 10));
      if (!binary && !header.includes('solid')) throw new Error(invalid);
      if (binary && triangles > 1_000_000) throw new Error('Ce modèle contient trop de triangles pour l’aperçu.');
      let geometry: Three.BufferGeometry;
      try { geometry = this.geometry = new STLLoader().parse(buffer); }
      catch { throw new Error(invalid); }
      const positions = geometry.getAttribute('position');
      if (!positions || positions.count < 3 || positions.count % 3 !== 0 || positions.count > 3_000_000 ||
          !positions.array.every(Number.isFinite)) throw new Error(invalid);
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(longest) || longest <= 0) throw new Error('Le fichier ne contient pas de pièce affichable.');
      const number = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
      this.dimensions.set(`X ${number(size.x)} × Y ${number(size.y)} × Z ${number(size.z)} · ${number(positions.count / 3)} triangles`);
      geometry.center();
      geometry.scale(2 / longest, 2 / longest, 2 / longest);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#eef2ec');
      this.material = new THREE.MeshStandardMaterial({ color: '#639c86', roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
      scene.add(new THREE.Mesh(geometry, this.material));
      scene.add(new THREE.HemisphereLight(0xffffff, 0x667060, 2.5));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(3, -4, 6);
      scene.add(light);
      const grid = this.grid = new THREE.GridHelper(6, 30, '#b2bfb1', '#d7dfd3');
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -size.z / longest - 0.005;
      scene.add(grid);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
      camera.up.set(0, 0, 1);
      const render = () => { if (!this.destroyed) this.renderer?.render(scene, camera); };
      this.zone.runOutsideAngular(() => {
        const controls = this.controls = new OrbitControls(camera, canvas);
        const resize = () => {
          const { width, height } = this.surface.nativeElement.getBoundingClientRect();
          if (!width || !height) return;
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          this.renderer!.setSize(width, height, false);
          render();
        };
        // Cadre aussi une pièce large sur un écran de téléphone.
        const aspect = this.surface.nativeElement.clientWidth / this.surface.nativeElement.clientHeight;
        const distance = geometry.boundingSphere!.radius * 1.15 / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * Math.min(1, aspect)));
        camera.position.set(1, -1.4, 1).normalize().multiplyScalar(distance);
        controls.minDistance = 0.1;
        controls.maxDistance = Math.max(25, distance * 2);
        controls.update();
        controls.saveState();
        controls.addEventListener('change', render);
        this.observer = new ResizeObserver(resize);
        this.observer.observe(this.surface.nativeElement);
        resize();
      });
      this.ready.set(true);
    } catch (error) {
      if (!this.destroyed) {
        this.error.set(error instanceof Error ? error.message : 'Impossible d’afficher ce fichier STL.');
        this.releaseGraphics();
      }
    } finally { if (!this.destroyed) this.loading.set(false); }
  }

  private async readFile(response: Response): Promise<ArrayBuffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Le navigateur ne permet pas de charger cet aperçu.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) { await reader.cancel(); throw new Error('Aperçu limité à 50 Mo.'); }
        chunks.push(value);
        this.progress.set(`${(length / 1024 / 1024).toFixed(1)} Mo`);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.ready.set(false);
    this.error.set('Le contexte graphique a été perdu. Ferme l’aperçu puis réessaie.');
  };

  private releaseGraphics() {
    this.observer?.disconnect();
    this.controls?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.grid?.geometry.dispose();
    if (this.grid) {
      const materials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
      materials.forEach(material => material.dispose());
    }
    this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
    this.renderer = undefined;
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.abort.abort();
    this.releaseGraphics();
    this.dialog.nativeElement.close();
    this.previousFocus?.focus();
  }
}
