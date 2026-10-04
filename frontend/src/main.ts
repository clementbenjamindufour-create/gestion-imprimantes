import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, RouterOutlet } from '@angular/router';
import { WorkspaceComponent } from './app/workspace.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
class AppComponent {}

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter([
      { path: 'library', component: WorkspaceComponent },
      { path: 'projects/:projectId', component: WorkspaceComponent },
      { path: '', redirectTo: 'library', pathMatch: 'full' },
      { path: '**', redirectTo: 'library' },
    ]),
  ],
}).catch(console.error);
