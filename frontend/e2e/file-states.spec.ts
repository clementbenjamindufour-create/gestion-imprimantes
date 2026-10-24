import { expect, test } from '@playwright/test';

test('états de toute la bibliothèque proposés dans un projet, nouveaux états réutilisables', async ({ page }) => {
  const files = [null, 'Prêt', 'Prêt', 'À slicer', ''].map((state, index) => ({
    id: String(index), filename: `piece${index}.stl`, extension: '.stl', kind: 'model',
    state, size_bytes: 12, is_print_related: true, created_at: '2026-10-24T10:00:00Z',
  }));
  const project = { id: 'p', name: 'Projet états', created_at: files[0].created_at };
  let uploadedState = '';
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/files')) {
      const content = request.postDataBuffer()!.toString();
      uploadedState = /name="state"\r\n\r\n([^\r\n]*)/.exec(content)?.[1] ?? '';
      const file = { ...files[0], id: 'new', filename: 'nouvelle.stl', state: uploadedState };
      files.push(file);
      return route.fulfill({ json: file });
    }
    if (request.method() === 'PUT') return route.fulfill({ status: 204 });
    if (request.method() === 'PATCH') {
      files[0].state = request.postDataJSON().state;
      return route.fulfill({ json: files[0] });
    }
    const data = path.endsWith('/projects') ? [project] : path.endsWith('/projects/p') ? { ...project, files: files.filter(file => file.id === '0' || file.id === 'new'), notes: [], todos: [] } : path.endsWith('/files') ? files : { total_bytes: 1000, used_bytes: 10, free_bytes: 990 };
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Projet états' }).click();
  await page.getByRole('button', { name: 'Importer des fichiers', exact: true }).first().click();
  const input = page.locator('#file-state');
  const options = page.locator('#known-file-states option');
  await expect(input).toHaveAttribute('list', 'known-file-states');
  await expect(options).toHaveCount(2);
  expect(await options.evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value))).toEqual(['À slicer', 'Prêt']);
  await input.fill('Supports validés');
  await page.locator('#upload-file').setInputFiles({ name: 'nouvelle.stl', mimeType: 'application/octet-stream', buffer: Buffer.from('example') });
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(page.locator('.import-queue .import-done')).toHaveCount(1);
  expect(uploadedState).toBe('Supports validés');
  await expect(page.locator('#known-file-states option[value="Supports validés"]')).toHaveCount(1);
  const row = page.getByRole('row').filter({ hasText: 'piece0.stl' });
  await row.getByRole('button', { name: 'Modifier l’état' }).click();
  const edit = row.getByLabel('État du fichier');
  await expect(edit).toHaveAttribute('list', 'known-file-states');
  await edit.fill('En cours');
  await row.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.locator('#known-file-states option[value="En cours"]')).toHaveCount(1);
});
