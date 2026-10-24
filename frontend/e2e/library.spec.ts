import { expect, test } from '@playwright/test';

test('projet, import, téléchargement, note et déliaison persistante', async ({ page }) => {
  const name = `Projet test ${Date.now()}`;
  const filename = `piece-${Date.now()}.STL`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ta bibliothèque de fabrication' })).toBeVisible();
  await page.getByRole('button', { name: 'Créer un projet', exact: true }).click();
  await page.getByLabel('Nom du projet').fill(name);
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Importer des fichiers', exact: true }).first().click();
  await page.locator('#upload-file').setInputFiles({
    name: filename, mimeType: 'application/octet-stream', buffer: Buffer.from('solid test\nendsolid'),
  });
  await page.getByLabel('État').fill('À slicer / supports à vérifier');
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: filename });
  await expect(row).toContainText('Modèle 3D');
  await expect(row).toContainText('À slicer / supports à vérifier');
  const downloadPromise = page.waitForEvent('download');
  await row.getByRole('checkbox', { name: `Sélectionner ${filename}`, exact: true }).check();
  await page.getByRole('button', { name: 'Télécharger la sélection' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  await page.getByLabel('Ajouter une note', { exact: true }).fill('Réglages à conserver.\nSupports à revoir.');
  await page.getByRole('button', { name: 'Ajouter la note', exact: true }).click();
  await expect(page.locator('.note-card')).toContainText('Supports à revoir.');
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(row).toBeVisible();
  await page.screenshot({ path: 'test-results/project-desktop.png', fullPage: true });
  await row.getByRole('checkbox', { name: `Sélectionner ${filename}`, exact: true }).check();
  await page.getByRole('button', { name: 'Délier la sélection du projet' }).click();
  await expect(row).toHaveCount(0);
  const select = page.getByLabel('Fichier à lier');
  const fileId = await select.locator('option').filter({ hasText: filename }).getAttribute('value');
  await select.selectOption(fileId!);
  await page.getByRole('button', { name: 'Lier au projet', exact: true }).click();
  await expect(row).toBeVisible();
  await page.getByRole('link', { name: /Tous les fichiers/ }).click();
  await page.getByRole('textbox', { name: 'Rechercher un fichier' }).fill('supports à vérifier');
  await expect(page.getByRole('row').filter({ hasText: filename })).toBeVisible();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aucun fichier correspondant' })).toBeVisible();
});

test('affiche une erreur et permet de réessayer', async ({ page }) => {
  await page.route('**/api/v1/projects', route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/library');
  await expect(page.getByRole('alert')).toContainText('L’opération a échoué');
  await page.unroute('**/api/v1/projects');
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('navigation et formulaires sur téléphone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: 'Ta bibliothèque de fabrication' })).toBeVisible();
  await page.getByRole('button', { name: 'Importer des fichiers', exact: true }).first().click();
  await expect(page.locator('#upload-file')).toBeVisible();
  await page.screenshot({ path: 'test-results/library-mobile.png', fullPage: true });
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('*')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth)
      .map(element => ({ tag: element.tagName, class: element.className })),
  }));
  expect(layout.width, JSON.stringify(layout)).toBe(layout.viewport);
});
