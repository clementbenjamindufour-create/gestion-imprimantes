import { expect, Page, test } from '@playwright/test';

const selection = ['piece.stl', 'couches.goo', 'notice.txt'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('example') }));

async function mockLibrary(page: Page, options: { failUpload?: string; failLink?: boolean; waitFirst?: Promise<void> } = {}) {
  const files: any[] = [];
  const uploads: string[] = [];
  const links: string[] = [];
  let failedUpload = false, failedLink = false, active = 0, maxActive = 0;
  const project = { id: 'project', name: 'Projet bulk', created_at: '2026-10-24T10:00:00Z' };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/files') && request.method() === 'POST') {
      const content = request.postDataBuffer()!.toString();
      const filename = /filename="([^"]+)"/.exec(content)![1];
      uploads.push(filename);
      active++; maxActive = Math.max(active, maxActive);
      if (uploads.length === 1 && options.waitFirst) await options.waitFirst;
      if (filename === options.failUpload && !failedUpload) {
        failedUpload = true; active--;
        return route.fulfill({ status: 503, json: { detail: 'Erreur temporaire de stockage' } });
      }
      const file = { id: `file-${files.length}`, filename, size_bytes: 7, extension: '.' + filename.split('.').pop(), kind: 'other', state: null, is_print_related: false, created_at: project.created_at };
      files.push(file); active--;
      return route.fulfill({ json: file });
    }
    if (request.method() === 'PUT') {
      links.push(path);
      if (options.failLink && !failedLink) { failedLink = true; return route.fulfill({ status: 503 }); }
      return route.fulfill({ status: 204 });
    }
    const data = path.endsWith('/projects') ? [project] : path.endsWith('/projects/project') ? { ...project, files, notes: [], todos: [] } : path.endsWith('/files') ? files : { total_bytes: 1000, used_bytes: 10, free_bytes: 990 };
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ta bibliothèque de fabrication' })).toBeVisible();
  return { uploads, links, maxActive: () => maxActive };
}

async function choose(page: Page, files = selection) {
  await page.getByRole('button', { name: 'Importer des fichiers', exact: true }).first().click();
  await page.locator('#upload-file').setInputFiles(files);
  await expect(page.getByRole('list', { name: 'Fichiers à importer' }).getByRole('listitem')).toHaveCount(files.length);
}

test('importe plusieurs fichiers successivement avec état commun et bilan', async ({ page }, info) => {
  const api = await mockLibrary(page);
  await choose(page);
  await page.getByLabel('État').fill('À vérifier');
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request.postDataBuffer()!.toString()); });
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 fichiers importés avec succès' })).toBeVisible();
  expect(api.uploads).toEqual(selection.map(file => file.name));
  expect(api.maxActive()).toBe(1);
  expect(requests.every(body => body.includes('À vérifier'))).toBeTruthy();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  await expect(page.getByRole('progressbar', { name: 'Progression de l’import' })).toHaveAttribute('value', '3');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('bulk-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('un échec ne bloque pas le lot et la reprise ne renvoie que le fichier en échec', async ({ page }) => {
  const api = await mockLibrary(page, { failUpload: 'couches.goo' });
  await choose(page);
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(2);
  await expect(page.locator('.import-queue .import-failed')).toContainText('Erreur temporaire de stockage');
  await page.getByRole('button', { name: 'Réessayer les échecs (1)' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  expect(api.uploads).toEqual(['piece.stl', 'couches.goo', 'notice.txt', 'couches.goo']);
});

test('réessaie une liaison échouée sans réimporter le fichier', async ({ page }) => {
  const api = await mockLibrary(page, { failLink: true });
  await page.getByRole('link', { name: 'Projet bulk' }).click();
  await choose(page);
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await expect(page.locator('.import-queue .import-failed')).toContainText('non lié au projet');
  await expect(page.locator('.import-queue .import-done')).toHaveCount(2);
  await page.getByRole('button', { name: 'Réessayer les échecs (1)' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  expect(api.uploads).toHaveLength(3);
  expect(api.links).toHaveLength(4);
  expect(api.links[3]).toBe(api.links[0]);
});

test('arrêt après le fichier actif puis poursuite des fichiers restants', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const api = await mockLibrary(page, { waitFirst: waiting });
  await choose(page);
  const started = page.waitForRequest(request => request.method() === 'POST');
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await started;
  await page.getByRole('button', { name: 'Arrêter après ce fichier' }).click();
  release();
  await expect(page.getByRole('button', { name: 'Importer les 2 fichiers' })).toBeEnabled();
  expect(api.uploads).toEqual(['piece.stl']);
  await page.getByRole('button', { name: 'Importer les 2 fichiers' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  expect(api.uploads).toEqual(selection.map(file => file.name));
});

test('retire un fichier avant l’import', async ({ page }) => {
  const api = await mockLibrary(page);
  await choose(page);
  await page.getByRole('button', { name: 'Retirer couches.goo' }).click();
  await page.getByRole('button', { name: 'Importer les 2 fichiers' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(2);
  expect(api.uploads).toEqual(['piece.stl', 'notice.txt']);
});

test('protège la navigation pendant le lot et conserve le projet cible', async ({ page }) => {
  let release!: () => void;
  const waitFirst = new Promise<void>(resolve => { release = resolve; });
  const api = await mockLibrary(page, { waitFirst });
  await page.getByRole('link', { name: 'Projet bulk' }).click();
  await choose(page);
  const started = page.waitForRequest(request => request.method() === 'POST');
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await started;
  await expect(page.locator('#upload-file')).toBeDisabled();
  await page.getByRole('link', { name: /Tous les fichiers/ }).click();
  await expect(page).toHaveURL(/\/projects\/project$/);
  await expect(page.getByRole('status').filter({ hasText: 'avant de changer de page' })).toBeVisible();
  release();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  expect(api.links).toHaveLength(3);
  expect(api.links.every(path => path.startsWith('/api/v1/projects/project/files/'))).toBeTruthy();
  await page.getByRole('link', { name: /Tous les fichiers/ }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test('importe un seul fichier et permet une nouvelle sélection du même fichier', async ({ page }) => {
  const api = await mockLibrary(page);
  await choose(page, [selection[0]]);
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(1);
  await expect(page.locator('#upload-file')).toBeEnabled();
  await page.locator('#upload-file').setInputFiles([selection[0]]);
  await expect(page.getByRole('button', { name: 'Importer', exact: true })).toBeEnabled();
  expect(api.uploads).toHaveLength(1);
});

test('désactive la liaison au projet pour tout le lot', async ({ page }) => {
  const api = await mockLibrary(page);
  await page.getByRole('link', { name: 'Projet bulk' }).click();
  await choose(page);
  await page.getByRole('checkbox', { name: 'Lier à ce projet' }).uncheck();
  await page.getByRole('button', { name: 'Importer les 3 fichiers' }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(3);
  expect(api.links).toHaveLength(0);
});
