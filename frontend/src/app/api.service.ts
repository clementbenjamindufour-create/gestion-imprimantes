import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface LibraryFile {
  id: string;
  filename: string;
  size_bytes: number;
  extension: string;
  kind: 'model' | 'sliced' | 'slicer_project' | 'other';
  is_print_related: boolean;
  state: string | null;
  created_at: string;
}
export interface Project { id: string; name: string; created_at: string; }
export interface Note { id: string; project_id: string; content: string; created_at: string; }
export interface Todo extends Note { completed: boolean; }
export interface ProjectDetail extends Project { files: LibraryFile[]; notes: Note[]; todos: Todo[]; }
export interface Storage { total_bytes: number; used_bytes: number; free_bytes: number; }

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = '/api/v1';

  storage() { return firstValueFrom(this.http.get<Storage>(`${this.base}/storage`)); }

  files() { return firstValueFrom(this.http.get<LibraryFile[]>(`${this.base}/files`)); }
  projects() { return firstValueFrom(this.http.get<Project[]>(`${this.base}/projects`)); }
  project(id: string) {
    return firstValueFrom(this.http.get<ProjectDetail>(`${this.base}/projects/${id}`));
  }
  createProject(name: string) {
    return firstValueFrom(this.http.post<Project>(`${this.base}/projects`, { name }));
  }
  upload(file: File, state: string) {
    const data = new FormData();
    data.append('file', file);
    if (state) data.append('state', state);
    return firstValueFrom(this.http.post<LibraryFile>(`${this.base}/files`, data));
  }
  link(projectId: string, fileId: string) {
    return firstValueFrom(this.http.put<void>(`${this.base}/projects/${projectId}/files/${fileId}`, {}));
  }
  unlink(projectId: string, fileId: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/projects/${projectId}/files/${fileId}`));
  }
  note(projectId: string, content: string) {
    return firstValueFrom(this.http.post<Note>(`${this.base}/projects/${projectId}/notes`, { content }));
  }
  downloadUrl(id: string) { return `${this.base}/files/${id}/download`; }
  deleteFile(id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/files/${id}`));
  }
  updateState(id: string, state: string | null) {
    return firstValueFrom(this.http.patch<LibraryFile>(`${this.base}/files/${id}`, { state }));
  }
  updateNote(projectId: string, id: string, content: string) {
    return firstValueFrom(this.http.patch<Note>(`${this.base}/projects/${projectId}/notes/${id}`, { content }));
  }
  deleteNote(projectId: string, id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/projects/${projectId}/notes/${id}`));
  }
  createTodo(projectId: string, content: string) {
    return firstValueFrom(this.http.post<Todo>(`${this.base}/projects/${projectId}/todos`, { content }));
  }
  updateTodo(projectId: string, id: string, update: {content?: string; completed?: boolean}) {
    return firstValueFrom(this.http.patch<Todo>(`${this.base}/projects/${projectId}/todos/${id}`, update));
  }
  deleteTodo(projectId: string, id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/projects/${projectId}/todos/${id}`));
  }
}
