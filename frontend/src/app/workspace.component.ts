import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiService, LibraryFile, Note, Todo, Project, ProjectDetail } from './api.service';

@Component({
  selector: 'app-workspace',
  imports: [FormsModule, RouterLink, DatePipe],
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
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly search = signal('');
  readonly filter = signal('all');
  readonly showImport = signal(false);
  readonly showCreate = signal(false);
  readonly selectedFile = signal<File | null>(null);
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
      const [projects, files, project] = await Promise.all([
        this.api.projects(), this.api.files(), id ? this.api.project(id) : Promise.resolve(null),
      ]);
      if (version !== this.loadVersion) return;
      this.projects.set(projects);
      this.files.set(files);
      this.project.set(project);
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
    const input = event.target as HTMLInputElement;
    this.selectedFile.set(input.files?.[0] ?? null);
  }

  async importFile(input: HTMLInputElement) {
    const file = this.selectedFile();
    if (!file) return;
    const projectId = this.attachImport ? this.projectId() : null;
    await this.mutate(async () => {
      const uploaded = await this.api.upload(file, this.fileState);
      // Après un import réussi, ne pas réimporter si le lien échoue.
      this.selectedFile.set(null);
      input.value = '';
      this.fileState = '';
      this.showImport.set(false);
      let linkError = false;
      if (projectId) {
        try { await this.api.link(projectId, uploaded.id); }
        catch { linkError = true; }
      }
      await this.reload();
      if (linkError) {
        this.error.set('Fichier importé dans la bibliothèque, mais non lié au projet. Utilise « Lier un fichier existant ».');
      } else {
        this.notice.set(projectId ? 'Fichier importé et lié au projet.' : 'Fichier importé dans la bibliothèque.');
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
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
}
