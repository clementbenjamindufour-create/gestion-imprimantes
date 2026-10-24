import { expect, Page, test } from '@playwright/test';

const files = [
  { id: '10', filename: 'pièce10.stl', kind: 'model', state: null, size_bytes: 10000 },
  { id: 'e', filename: 'Éclair.goo', kind: 'sliced', state: 'À vérifier', size_bytes: 2 },
  { id: '2', filename: 'Pièce2.stl', kind: 'model', state: 'Prêt', size_bytes: 2000 },
  { id: 'a', filename: 'alpha.obj', kind: 'other', state: 'À slicer', size_bytes: 20 },
].map(file => ({ ...file, extension: '.' + file.filename.split('.').pop(), is_print_related: file.kind !== 'other', created_at: '2026-10-24T10:00:00Z' }));
const names = ['alpha.obj', 'Éclair.goo', 'Pièce2.stl', 'pièce10.stl'];
const rows = (page: Page) => page.locator('tbody .file-name strong');
const sortButton = (page: Page, column: string) => page.getByRole('button', { name: new RegExp(`^Trier par ${column} `) });
const header = (page: Page, column: string) => page.getByRole('columnheader').filter({ has: sortButton(page, column) });

async function library(page: Page) {
  const project = { id: 'tri', name: 'Projet tri', created_at: '2026-10-24T10:00:00Z' };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/files') ? files : path.endsWith('/projects') ? [project] : path.endsWith('/projects/tri') ? { ...project, files, notes: [], todos: [] } : { total_bytes: 1000, used_bytes: 10, free_bytes: 990 };
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(rows(page)).toHaveCount(4);
}

for (const project of [false, true]) {
  test(`${project ? 'projet' : 'bibliothèque'} : nom par défaut et tri réversible des quatre colonnes`, async ({ page }) => {
    await library(page);
    if (project) await page.getByRole('link', { name: 'Projet tri' }).click();
    await expect(rows(page)).toHaveText(names);
    await expect(header(page, 'Nom du fichier')).toHaveAttribute('aria-sort', 'ascending');
    await sortButton(page, 'Nom du fichier').click();
    await expect(rows(page)).toHaveText([...names].reverse());
    await expect(header(page, 'Nom du fichier')).toHaveAttribute('aria-sort', 'descending');
    await sortButton(page, 'Nom du fichier').click();
    await expect(rows(page)).toHaveText(names);
    await sortButton(page, 'Taille').click();
    await expect(rows(page)).toHaveText(['Éclair.goo', 'alpha.obj', 'Pièce2.stl', 'pièce10.stl']);
    await expect(header(page, 'Nom du fichier')).toHaveAttribute('aria-sort', 'none');
    await sortButton(page, 'Taille').click();
    await expect(rows(page)).toHaveText(['pièce10.stl', 'Pièce2.stl', 'alpha.obj', 'Éclair.goo']);
    await sortButton(page, 'État').click();
    await expect(rows(page)).toHaveText(['pièce10.stl', 'alpha.obj', 'Éclair.goo', 'Pièce2.stl']);
    await sortButton(page, 'État').click();
    await expect(rows(page)).toHaveText(['Pièce2.stl', 'Éclair.goo', 'alpha.obj', 'pièce10.stl']);
    await sortButton(page, 'Type').click();
    await expect(rows(page)).toHaveText(names);
    await sortButton(page, 'Type').focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveText(['Pièce2.stl', 'pièce10.stl', 'Éclair.goo', 'alpha.obj']);
  });
}

test('tri compatible avec filtres, sélection, actualisation et changement de page', async ({ page }) => {
  await library(page);
  const selected = page.getByRole('checkbox', { name: 'Sélectionner Pièce2.stl', exact: true });
  await selected.check();
  await sortButton(page, 'Taille').click();
  await expect(selected).toBeChecked();
  await page.getByRole('button', { name: /Actualiser/ }).click();
  await expect(header(page, 'Taille')).toHaveAttribute('aria-sort', 'ascending');
  await expect(selected).toBeChecked();
  await page.getByRole('textbox', { name: 'Rechercher un fichier' }).fill('pièce');
  await expect(rows(page)).toHaveText(['Pièce2.stl', 'pièce10.stl']);
  await sortButton(page, 'Taille').click();
  await expect(rows(page)).toHaveText(['pièce10.stl', 'Pièce2.stl']);
  await expect(selected).toBeChecked();
  await page.getByRole('link', { name: 'Projet tri' }).click();
  await expect(rows(page)).toHaveText(names);
  await expect(header(page, 'Nom du fichier')).toHaveAttribute('aria-sort', 'ascending');
  await expect(selected).not.toBeChecked();
});
