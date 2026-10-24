import { expect, Page, test } from '@playwright/test';

async function library(page: Page, failOnce = false) {
  let files = [
    { id: 'a', filename: 'piece.stl', extension: '.stl', kind: 'model' },
    { id: 'b', filename: 'piece.goo', extension: '.goo', kind: 'sliced' },
    { id: 'c', filename: 'notes.txt', extension: '.txt', kind: 'other' },
  ].map(file => ({ ...file, size_bytes: 12, is_print_related: file.kind !== 'other', state: null, created_at: '2026-10-24T10:00:00Z' }));
  const calls: { method: string; path: string; body: any }[] = [];
  let failed = false;
  const project = { id: 'project', name: 'Mon projet', created_at: '2026-10-24T10:00:00Z' };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET' || path.endsWith('/download')) calls.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (path.endsWith('/archive')) return route.fulfill({ contentType: 'application/zip', body: Buffer.from('test zip') });
    if (path.endsWith('/download')) return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="piece.stl"' }, body: 'test model' });
    if (method === 'DELETE' || method === 'PUT') {
      if (failOnce && path.endsWith('/b') && !failed) { failed = true; return route.fulfill({ status: 503, json: { detail: 'Erreur temporaire' } }); }
      if (method === 'DELETE') files = files.filter(file => !path.endsWith('/' + file.id));
      return route.fulfill({ status: 204 });
    }
    const data = path.endsWith('/projects') ? [project] : path.endsWith('/projects/project') ? { ...project, files, notes: [], todos: [] } : path.endsWith('/files') ? files : { total_bytes: 1000, used_bytes: 10, free_bytes: 990 };
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'Sélectionner piece.stl', exact: true })).toBeVisible();
  return calls;
}

const checkbox = (page: Page, name: string) => page.getByRole('checkbox', { name: `Sélectionner ${name}`, exact: true });

test('sélection individuelle, indéterminée et globale limitée aux fichiers visibles', async ({ page }) => {
  await library(page);
  const all = page.getByRole('checkbox', { name: 'Sélectionner tous les fichiers visibles' });
  await expect(page.getByRole('button', { name: 'Télécharger la sélection' })).toBeDisabled();
  await checkbox(page, 'piece.stl').check();
  expect(await all.evaluate((element: HTMLInputElement) => element.indeterminate)).toBe(true);
  await page.getByRole('textbox', { name: 'Rechercher un fichier' }).fill('notes');
  await expect(all).not.toBeChecked();
  await all.check();
  await expect(page.getByRole('region', { name: 'Actions sur la sélection' })).toContainText('2 fichiers sélectionnés');
  await expect(page.getByRole('region', { name: 'Actions sur la sélection' })).toContainText('1 hors des filtres');
  await page.getByRole('textbox', { name: 'Rechercher un fichier' }).fill('');
  await expect(checkbox(page, 'piece.goo')).not.toBeChecked();
  await all.check();
  await expect(checkbox(page, 'piece.goo')).toBeChecked();
  await page.getByRole('button', { name: 'Tout décocher' }).click();
  await expect(all).not.toBeChecked();
});

test('téléchargement ZIP de la sélection, sans actions individuelles dans la bibliothèque', async ({ page }) => {
  const calls = await library(page);
  await expect(page.getByRole('row').filter({ hasText: 'piece.stl' }).getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Supprimer piece.stl', exact: true })).toHaveCount(0);
  await checkbox(page, 'piece.stl').check();
  await checkbox(page, 'piece.goo').check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Télécharger la sélection' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('selection.zip');
  expect(await download.failure()).toBeNull();
  expect(calls.find(call => call.path.endsWith('/archive'))?.body).toEqual({ file_ids: ['a', 'b'] });
  await expect(checkbox(page, 'piece.stl')).toBeChecked();
});

test('un fichier sélectionné se télécharge directement', async ({ page }) => {
  const calls = await library(page);
  await checkbox(page, 'piece.stl').check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Télécharger la sélection' }).click();
  expect((await downloading).suggestedFilename()).toBe('piece.stl');
  expect(calls.some(call => call.path.endsWith('/archive'))).toBe(false);
});

test('suppression confirmée une seule fois et annulation sans modification', async ({ page }) => {
  const calls = await library(page);
  await checkbox(page, 'piece.stl').check();
  await checkbox(page, 'piece.goo').check();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Supprimer la sélection' }).click();
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  let confirmations = 0;
  page.once('dialog', async dialog => { confirmations++; expect(dialog.message()).toContain('tous leurs projets'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Supprimer la sélection' }).click();
  await expect(checkbox(page, 'piece.stl')).toHaveCount(0);
  await expect(checkbox(page, 'piece.goo')).toHaveCount(0);
  await expect(checkbox(page, 'notes.txt')).toBeVisible();
  expect(confirmations).toBe(1);
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(2);
});

for (const action of ['delete', 'link'] as const) {
  test(`échec partiel ${action} : conserve seulement les échecs cochés pour la reprise`, async ({ page }) => {
    const calls = await library(page, true);
    await checkbox(page, 'piece.stl').check();
    await checkbox(page, 'piece.goo').check();
    if (action === 'link') await page.getByLabel('Projet de destination').selectOption('project');
    else page.on('dialog', dialog => dialog.accept());
    const button = page.getByRole('button', { name: action === 'link' ? 'Lier la sélection au projet' : 'Supprimer la sélection' });
    await button.click();
    await expect(page.locator('.selection-errors')).toContainText('piece.goo');
    await expect(checkbox(page, 'piece.goo')).toBeChecked();
    await expect(button).toBeEnabled();
    if (action === 'link') await expect(checkbox(page, 'piece.stl')).not.toBeChecked();
    else await expect(checkbox(page, 'piece.stl')).toHaveCount(0);
    await button.click();
    await expect(page.locator('.selection-errors')).toHaveCount(0);
    await expect(button).toBeDisabled();
    const actions = calls.filter(call => call.method === (action === 'link' ? 'PUT' : 'DELETE'));
    expect(actions.map(call => call.path.split('/').pop())).toEqual(['a', 'b', 'b']);
    if (action === 'link') expect(actions.every(call => call.path.startsWith('/api/v1/projects/project/files/'))).toBe(true);
  });
}

test('sélection réinitialisée après changement de page et interface utilisable sur mobile', async ({ page }, info) => {
  await library(page);
  await checkbox(page, 'piece.stl').check();
  await page.getByRole('link', { name: 'Mon projet' }).click();
  await expect(page.getByRole('region', { name: 'Actions sur la sélection' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Télécharger piece.stl', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Tous les fichiers/ }).click();
  await expect(checkbox(page, 'piece.stl')).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkbox(page, 'piece.stl').check();
  await page.screenshot({ path: info.outputPath('selection-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
