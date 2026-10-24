import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, LibraryFile, Note, Todo, Project, ProjectDetail, Storage } from './api.service';
import { StlPreviewComponent } from './stl-preview.component';

interface ImportItem {
  id: number;
  file: File;
  status: 'pending' | 'uploading' | 'linking' | 'done' | 'upload_error' | 'link_error';
  message: string;
  uploadedId?: string;
  projectId?: string | null;
  state?: string;
}

@Component({
  selector: 'app-workspace',
  imports: [FormsModule, RouterLink, DatePipe, StlPreviewComponent],
  templateUrl: './workspace.component.html',
})
export class WorkspaceComponent {
  readonly api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly projects = signal<Project[]>([]);
  readonly files = signal<LibraryFile[]>([]);
  readonly project = signal<ProjectDetail | null>(null);
  readonly projectId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly storage = signal<Storage | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly search = signal('');
  readonly filter = signal('all');
  readonly showImport = signal(false);
  readonly showCreate = signal(false);
  readonly imports = signal<ImportItem[]>([]);
  readonly importing = signal(false);
  readonly stopRequested = signal(false);
  readonly pendingImports = computed(() => this.imports().filter(item => item.status === 'pending').length);
  readonly failedImports = computed(() => this.imports().filter(item => item.status === 'upload_error' || item.status === 'link_error').length);
  readonly finishedImports = computed(() => this.imports().filter(item => ['done', 'upload_error', 'link_error'].includes(item.status)).length);
  readonly importSize = computed(() => this.imports().reduce((sum, item) => sum + item.file.size, 0));
  private importId = 0;
  readonly previewFile = signal<LibraryFile | null>(null);
  readonly selectedIds = signal(new Set<string>());
  readonly selectedFiles = computed(() => this.scopedFiles().filter(file => this.selectedIds().has(file.id)));
  readonly destinationProjects = computed(() => this.projects().filter(project => project.id !== this.projectId()));
  readonly allVisibleSelected = computed(() => this.visibleFiles().length > 0 && this.visibleFiles().every(file => this.selectedIds().has(file.id)));
  readonly someVisibleSelected = computed(() => !this.allVisibleSelected() && this.visibleFiles().some(file => this.selectedIds().has(file.id)));
  readonly hiddenSelected = computed(() => {
    const visible = new Set(this.visibleFiles().map(file => file.id));
    return this.selectedFiles().filter(file => !visible.has(file.id)).length;
  });
  readonly bulkWorking = signal(false);
  readonly bulkStatus = signal('');
  readonly bulkErrors = signal<{ filename: string; message: string }[]>([]);
  bulkProjectId = '';
  projectName = '';
  fileState = '';
  noteContent = '';
  attachImport = true;
  linkFileId = '';
  editingState = signal<string | null>(null);
  editingNote = signal<string | null>(null);
  editingTodo = signal<string | null>(null);
  stateDraft = '';
  noteDraft = '';
  todoDraft = '';
  todoContent = '';
  private loadVersion = 0;

  readonly scopedFiles = computed(() => this.projectId() ? (this.project()?.files ?? []) : this.files());
  readonly visibleFiles = computed(() => {
    const search = this.search().trim().toLocaleLowerCase();
    return this.scopedFiles().filter(file =>
      (!search || `${file.filename} ${file.state ?? ''}`.toLocaleLowerCase().includes(search)) &&
      (this.filter() === 'all' || file.kind === this.filter()));
  });
  readonly attachableFiles = computed(() => {
    const linked = new Set(this.project()?.files.map(file => file.id) ?? []);
    return this.files().filter(file => !linked.has(file.id));
  });
  readonly printFileCount = computed(() => this.scopedFiles().filter(f => f.is_print_related).length);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      this.projectId.set(params.get('projectId'));
      this.selectedIds.set(new Set());
      this.bulkProjectId = '';
      this.bulkErrors.set([]);
      this.previewFile.set(null);
      this.project.set(null);
      this.search.set('');
      this.filter.set('all');
      this.linkFileId = '';
      this.noteContent = '';
      this.todoContent = '';
      this.editingState.set(null);
      this.editingNote.set(null);
      this.editingTodo.set(null);
      void this.reload();
    });
  }

  async reload() {
    const version = ++this.loadVersion;
    const id = this.projectId();
    this.loading.set(true);
    this.error.set('');
    try {
      const [projects, files, project, storage] = await Promise.all([
        this.api.projects(), this.api.files(), id ? this.api.project(id) : Promise.resolve(null),
        this.api.storage().catch(() => null),
      ]);
      if (version !== this.loadVersion) return;
      this.projects.set(projects);
      this.files.set(files);
      const selectable = id ? (project?.files ?? []) : files;
      this.selectedIds.update(ids => new Set(selectable.filter(file => ids.has(file.id)).map(file => file.id)));
      this.project.set(project);
      this.storage.set(storage);
    } catch (error) {
      if (version === this.loadVersion) this.error.set(this.errorMessage(error));
    } finally {
      if (version === this.loadVersion) this.loading.set(false);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return 'Le serveur est injoignable. Vérifie la connexion puis réessaie.';
      if (error.status === 404) return 'Ce projet ou ce fichier est introuvable.';
      if (error.status === 413) return 'Le fichier dépasse la taille autorisée par le serveur.';
      if (typeof error.error?.detail === 'string') return error.error.detail;
    }
    return 'L’opération a échoué. Réessaie dans quelques instants.';
  }

  private async mutate(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(this.errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  async createProject() {
    const name = this.projectName.trim();
    if (!name) return;
    await this.mutate(async () => {
      const project = await this.api.createProject(name);
      this.projectName = '';
      this.showCreate.set(false);
      await this.router.navigate(['/projects', project.id]);
      this.notice.set('Projet créé. Tu peux y ajouter des fichiers et des notes.');
    });
  }

  chooseFile(event: Event) {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement;
    this.imports.set(Array.from(input.files ?? []).map(file => ({ id: ++this.importId, file, status: 'pending', message: 'En attente' })));
  }

  removeImport(id: number) {
    if (!this.busy()) this.imports.update(items => items.filter(item => item.id !== id));
  }

  private updateImport(id: number, patch: Partial<ImportItem>) {
    this.imports.update(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  }

  canLeaveImport(): boolean {
    if (this.bulkWorking()) {
      this.notice.set('Une action sur la sélection est en cours. Attends sa fin avant de changer de page.');
      return false;
    }
    if (!this.importing()) return true;
    this.notice.set('Import en cours : attends la fin du lot ou utilise « Arrêter après ce fichier » avant de changer de page.');
    return false;
  }

  @HostListener('window:beforeunload', ['$event'])
  protectImport(event: BeforeUnloadEvent) {
    if (this.importing() || this.bulkWorking()) { event.preventDefault(); event.returnValue = ''; }
  }

  async importFile(input: HTMLInputElement, retry = false) {
    if (this.busy()) return;
    const candidates = this.imports().filter(item => retry
      ? item.status === 'upload_error' || item.status === 'link_error'
      : item.status === 'pending');
    if (!candidates.length) return;
    const projectId = this.attachImport ? this.projectId() : null;
    // Fige le projet et l'etat du lot, meme si la route change pendant l'envoi.
    const items = candidates.map(item => ({ ...item,
      projectId: item.projectId === undefined ? projectId : item.projectId,
      state: item.state === undefined ? this.fileState : item.state,
    }));
    for (const item of items) this.updateImport(item.id, { projectId: item.projectId, state: item.state });
    await this.mutate(async () => {
      this.importing.set(true);
      this.stopRequested.set(false);
      try {
        for (const item of items) {
          if (this.stopRequested()) break;
          let uploadedId = item.uploadedId;
          if (!uploadedId) {
            this.updateImport(item.id, { status: 'uploading', message: 'Import en cours…' });
            try {
              const uploaded = await this.api.upload(item.file, item.state);
              uploadedId = uploaded.id;
              this.updateImport(item.id, { uploadedId });
            } catch (error) {
              this.updateImport(item.id, { status: 'upload_error', message: this.errorMessage(error) });
              continue;
            }
          }
          if (item.projectId) {
            this.updateImport(item.id, { status: 'linking', message: 'Liaison au projet…' });
            try { await this.api.link(item.projectId, uploadedId); }
            catch {
              this.updateImport(item.id, { status: 'link_error', message: 'Importé dans la bibliothèque, mais non lié au projet. Réessaie la liaison.' });
              continue;
            }
          }
          this.updateImport(item.id, { status: 'done', message: item.projectId ? 'Importé et lié au projet' : 'Importé dans la bibliothèque' });
        }
        input.value = '';
        await this.reload();
        const completed = this.imports().filter(item => item.status === 'done').length;
        const summary = completed === 1 ? '1 fichier importé' : `${completed} fichiers importés`;
        this.notice.set(`${summary} avec succès.${this.failedImports() ? ` ${this.failedImports()} en échec.` : ''}${this.pendingImports() ? ` ${this.pendingImports()} en attente.` : ''}`);
        if (!this.pendingImports() && !this.failedImports()) this.fileState = '';
      } finally {
        this.importing.set(false);
      }
    });
  }

  async linkFile() {
    const projectId = this.projectId();
    if (!projectId || !this.linkFileId) return;
    const fileId = this.linkFileId;
    await this.mutate(async () => {
      await this.api.link(projectId, fileId);
      this.linkFileId = '';
      await this.reload();
      this.notice.set('Fichier lié au projet.');
    });
  }

  async unlinkFile(file: LibraryFile) {
    const projectId = this.projectId();
    if (!projectId) return;
    await this.mutate(async () => {
      await this.api.unlink(projectId, file.id);
      await this.reload();
      this.notice.set('Fichier délié. Il reste disponible dans la bibliothèque.');
    });
  }

  async createNote() {
    const projectId = this.projectId();
    if (!projectId || !this.noteContent.trim()) return;
    const content = this.noteContent;
    await this.mutate(async () => {
      await this.api.note(projectId, content);
      this.noteContent = '';
      await this.reload();
      this.notice.set('Note ajoutée au projet.');
    });
  }

  kindLabel(kind: string) {
    return ({ model: 'Modèle 3D', sliced: 'Fichier slicé', slicer_project: 'Profil / projet slicer', other: 'Document' } as Record<string, string>)[kind];
  }

  startStateEdit(file: LibraryFile) {
    this.stateDraft = file.state ?? '';
    this.editingState.set(file.id);
  }

  async saveState(file: LibraryFile) {
    const state = this.stateDraft || null;
    await this.mutate(async () => {
      await this.api.updateState(file.id, state);
      this.editingState.set(null);
      await this.reload();
      this.notice.set('État du fichier enregistré.');
    });
  }

  async deleteFile(file: LibraryFile) {
    if (!window.confirm(`Supprimer définitivement « ${file.filename} » de la bibliothèque et de tous ses projets ?`)) return;
    await this.mutate(async () => {
      await this.api.deleteFile(file.id);
      await this.reload();
      this.notice.set('Fichier supprimé de la bibliothèque et des projets.');
    });
  }

  toggleFile(id: string, checked: boolean) {
    if (this.busy()) return;
    this.selectedIds.update(ids => {
      const next = new Set(ids);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }


  toggleVisible(checked: boolean) {
    if (this.busy()) return;
    this.selectedIds.update(ids => {
      const next = new Set(ids);
      for (const file of this.visibleFiles()) {
        if (checked) next.add(file.id); else next.delete(file.id);
      }
      return next;
    });
  }

  async downloadSelected() {
    const files = this.selectedFiles();
    if (!files.length || this.busy()) return;
    await this.mutate(async () => {
      this.bulkWorking.set(true);
      this.bulkStatus.set('Préparation du téléchargement…');
      this.bulkErrors.set([]);
      try {
        const blob = files.length > 1 ? await this.api.archive(files.map(file => file.id)) : null;
        const url = blob ? URL.createObjectURL(blob) : this.api.downloadUrl(files[0].id);
        const link = document.createElement('a');
        link.href = url;
        link.download = blob ? 'selection.zip' : files[0].filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        if (blob) window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.notice.set('Téléchargement lancé.');
      } finally { this.bulkWorking.set(false); this.bulkStatus.set(''); }
    });
  }

  async actOnSelection(action: 'delete' | 'link' | 'unlink') {
    const files = this.selectedFiles();
    const projectId = this.bulkProjectId;
    const sourceProjectId = this.projectId();
    if (!files.length || this.busy() || (action === 'link' && !projectId) || (action === 'unlink' && !sourceProjectId)) return;
    if (action === 'delete' && !window.confirm(`Supprimer définitivement ${files.length} fichier(s) de la bibliothèque et de tous leurs projets ?\n\n${files.slice(0, 5).map(file => file.filename).join('\n')}${files.length > 5 ? '\n…' : ''}`)) return;
    await this.mutate(async () => {
      this.bulkWorking.set(true);
      this.bulkErrors.set([]);
      let completed = 0;
      try {
        for (const [index, file] of files.entries()) {
          this.bulkStatus.set(`${action === 'delete' ? 'Suppression' : action === 'unlink' ? 'Déliaison' : 'Liaison'} ${index + 1} / ${files.length} : ${file.filename}`);
          try {
            if (action === 'delete') await this.api.deleteFile(file.id);
            else if (action === 'unlink') await this.api.unlink(sourceProjectId!, file.id);
            else await this.api.link(projectId, file.id);
            completed++;
            this.selectedIds.update(ids => { const next = new Set(ids); next.delete(file.id); return next; });
          } catch (error) {
            this.bulkErrors.update(errors => [...errors, { filename: file.filename, message: this.errorMessage(error) }]);
          }
        }
        await this.reload();
        this.notice.set(`${completed} fichier(s) ${action === 'delete' ? 'supprimé(s)' : action === 'unlink' ? 'délié(s) du projet, conservé(s) dans la bibliothèque' : 'lié(s) au projet'}.${this.bulkErrors().length ? ' Les fichiers en échec restent sélectionnés.' : ''}`);
      } finally { this.bulkWorking.set(false); this.bulkStatus.set(''); }
    });
  }

  startNoteEdit(note: Note) {
    this.noteDraft = note.content;
    this.editingNote.set(note.id);
  }

  async saveNote(note: Note) {
    if (!this.noteDraft.trim()) return;
    const content = this.noteDraft;
    await this.mutate(async () => {
      await this.api.updateNote(note.project_id, note.id, content);
      this.editingNote.set(null);
      await this.reload();
      this.notice.set('Note enregistrée.');
    });
  }

  async deleteNote(note: Note) {
    if (!window.confirm('Supprimer cette note ?')) return;
    await this.mutate(async () => {
      await this.api.deleteNote(note.project_id, note.id);
      await this.reload();
      this.notice.set('Note supprimée.');
    });
  }

  async createTodo() {
    const id = this.projectId();
    const content = this.todoContent.trim();
    if (!id || !content) return;
    await this.mutate(async () => {
      await this.api.createTodo(id, content);
      this.todoContent = '';
      await this.reload();
      this.notice.set('Tâche ajoutée.');
    });
  }

  startTodoEdit(todo: Todo) {
    this.todoDraft = todo.content;
    this.editingTodo.set(todo.id);
  }

  async updateTodo(todo: Todo, completed?: boolean) {
    const update = completed === undefined ? {content: this.todoDraft.trim()} : {completed};
    if ('content' in update && !update.content) return;
    await this.mutate(async () => {
      await this.api.updateTodo(todo.project_id, todo.id, update);
      this.editingTodo.set(null);
      await this.reload();
    });
  }

  async deleteTodo(todo: Todo) {
    if (!window.confirm('Supprimer cette tâche ?')) return;
    await this.mutate(async () => {
      await this.api.deleteTodo(todo.project_id, todo.id);
      await this.reload();
      this.notice.set('Tâche supprimée.');
    });
  }

  formatSize(bytes: number) {
    if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} To`;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
}
