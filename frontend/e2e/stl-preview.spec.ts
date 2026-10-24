import { expect, test, Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] } });

function binaryStl() {
  const vertices = [
    [0, 0, 0, 20, 0, 0, 0, 30, 0],
    [0, 0, 0, 0, 0, 40, 20, 0, 0],
    [0, 0, 0, 0, 30, 0, 0, 0, 40],
    [20, 0, 0, 0, 0, 40, 0, 30, 0],
  ];
  const buffer = Buffer.alloc(84 + vertices.length * 50);
  // Un STL binaire peut aussi commencer par "solid".
  buffer.write('solid binary');
  buffer.writeUInt32LE(vertices.length, 80);
  vertices.forEach((triangle, index) => triangle.forEach((value, axis) => buffer.writeFloatLE(value, 84 + index * 50 + 12 + axis * 4)));
  return buffer;
}

async function library(page: Page, body: Buffer, size = body.length, status = 200) {
  let downloads = 0;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/download')) {
      downloads++;
      return route.fulfill({ status, contentType: 'application/octet-stream', body });
    }
    const file = { id: 'preview', filename: 'piece.STL', size_bytes: size, extension: '.STL', kind: 'model', state: null, is_print_related: true, created_at: '2026-10-24T10:00:00Z' };
    const data = path.endsWith('/files') ? [file, { ...file, id: 'document', filename: 'document.obj', extension: '.obj' }] : path.endsWith('/storage') ? {total_bytes: 1000, used_bytes: 100, free_bytes: 900} : [];
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Aperçu 3D de piece.STL' })).toBeVisible();
  return () => downloads;
}

test('STL binaire chargé au clic, dimensions, interactions et fermeture accessible', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const downloads = await library(page, binaryStl());
  expect(downloads()).toBe(0);
  await expect(page.getByRole('button', { name: /Aperçu 3D de/ })).toHaveCount(1);
  const open = page.getByRole('button', { name: 'Aperçu 3D de piece.STL' });
  await open.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('X 20 × Y 30 × Z 40');
  await expect(dialog).toContainText('4 triangles');
  await expect(dialog.getByRole('button', { name: 'Recentrer' })).toBeEnabled();
  expect(downloads()).toBe(1);
  const canvas = dialog.locator('canvas');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, { steps: 10 });
  await page.mouse.up();
  await page.mouse.wheel(0, -80);
  await dialog.getByRole('button', { name: 'Recentrer' }).click();
  await page.screenshot({ path: info.outputPath('stl-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await open.click();
  await expect(dialog.getByRole('button', { name: 'Recentrer' })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('stl-mobile.png') });
  const rect = (await dialog.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  expect(errors).toEqual([]);
});

test('STL ASCII accepté', async ({ page }) => {
  await library(page, Buffer.from('solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 15 0\nendloop\nendfacet\nendsolid triangle'));
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog')).toContainText('X 10 × Y 15 × Z 0');
  await expect(page.getByRole('dialog')).toContainText('1 triangles');
});

test('STL invalide et échec réseau explicites', async ({ page }) => {
  await library(page, Buffer.from('solid empty\nendsolid empty'));
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('vide, invalide');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.route('**/files/preview/download', route => route.fulfill({ status: 503 }));
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Impossible de récupérer');
});

test('avertissement et limite de taille avant tout téléchargement', async ({ page }) => {
  const downloads = await library(page, binaryStl(), 11 * 1024 * 1024);
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog')).toContainText('volumineux');
  expect(downloads()).toBe(0);
  await page.getByRole('button', { name: 'Charger l’aperçu' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Recentrer' })).toBeEnabled();
  expect(downloads()).toBe(1);
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.unrouteAll();
  const tooLargeDownloads = await library(page, binaryStl(), 51 * 1024 * 1024);
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('limité à 50 Mo');
  expect(tooLargeDownloads()).toBe(0);
});

test('absence de WebGL : message utile et téléchargement disponible', async ({ page }) => {
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext; });
  const downloads = await library(page, binaryStl());
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('WebGL 2');
  await expect(page.getByRole('link', { name: 'Télécharger le STL' })).toBeVisible();
  expect(downloads()).toBe(0);
});

test('fermer pendant le téléchargement permet de rouvrir normalement', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await library(page, binaryStl());
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/files/preview/download', async route => { await waiting; await route.fulfill({ body: binaryStl() }).catch(() => {}); });
  const request = page.waitForRequest('**/files/preview/download');
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await request;
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  await page.unroute('**/files/preview/download');
  await page.getByRole('button', { name: 'Aperçu 3D de piece.STL' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Recentrer' })).toBeEnabled();
  expect(errors).toEqual([]);
});
