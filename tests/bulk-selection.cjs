/* Run like regression.cjs. Verify batch deletion through the UI in isolated storage. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.addInitScript(() => { window.rejections = []; window.addEventListener('unhandledrejection', e => window.rejections.push(String(e.reason))); });
    await page.route('http://songform.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://songform.test/');
    await page.waitForFunction(() => state.loaded && !pendingSaves);
    const original = 'Intro-V1-Cx2(함께)-V2-C-inter(4마디)-Cx3-outro';
    await page.evaluate(async form => {
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 840;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 840);
      const blob = await canvasToBlob(canvas);
      const song = { id: 'original', title: '선택 삭제 연습', key: 'G', tempo: 'mid', lastForm: form,
        labels: [], placement: { x: .5, y: .1, size: .025, page: 0 }, sheets: [{ blob, w: 600, h: 840 }] };
      await idbPut('songs', song);
      for (let i = 1; i <= 2; i++) await idbPut('weeks', { id: 'week' + i, date: '2026-10-0' + i,
        songs: [{ id: 'entry' + i, songId: song.id, form }], target: 20 });
    }, original);
    await page.reload();
    await page.waitForFunction(() => state.weeks.length === 2 && !pendingSaves);
    const open = () => page.evaluate(() => go({ name: 'song', songId: weekOf('week1').songs[0].songId, weekId: 'week1', entryId: 'entry1' }));
    await open();
    const click = action => page.locator(`[data-act=${action}]`).first().click();
    const chip = i => page.locator(`[data-act=selChip][data-i="${i}"]`);
    const form = () => page.evaluate(() => currentForm());
    const selected = () => page.locator('.chip[aria-pressed=true]').count();
    await chip(2).tap();
    assert.equal(await page.locator('[data-act=chipRep]').count(), 3);
    await click('toggleChipSelection');
    assert.equal(await selected(), 0);
    assert.equal(await page.locator('[data-act=chipDel]').count(), 0);
    assert.equal(await page.locator('[data-act=deleteSelectedChips]').isDisabled(), true);
    await chip(1).tap(); await chip(4).tap(); await chip(4).tap();
    assert.equal(await selected(), 1);
    await chip(4).tap();
    assert.equal(await selected(), 2);
    assert.equal(await form(), original, 'selection must not edit the song');
    assert.equal(await page.locator('#stage').evaluate(el => getComputedStyle(el).touchAction), 'pan-y pinch-zoom');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'songform-bulk-'));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('.form-selection').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, 'selection-mobile.png'), animations: 'disabled' });
    await click('deleteSelectedChips');
    const remaining = 'Intro-Cx2(함께)-V2-inter(4마디)-Cx3-outro';
    assert.equal(await form(), remaining);
    assert.equal(await page.evaluate(() => state.edit.multiSelect), false);
    await click('undoEdit'); assert.equal(await form(), original);
    await click('redoEdit'); assert.equal(await form(), remaining);
    await click('undoEdit');
    console.log('PASS nonadjacent repeated sections delete together; one undo restores repeats, notes and order');

    await click('toggleChipSelection'); await click('selectAllChips');
    assert.equal(await selected(), 8);
    await click('selectAllChips'); assert.equal(await selected(), 0);
    await chip(2).tap(); await click('toggleChipSelection');
    assert.equal(await form(), original);
    assert.equal(await selected(), 0);
    await click('toggleChipSelection'); await chip(1).tap();
    await click('typeForm'); await page.locator('#askIn').fill('V3-C'); await page.locator('#askOk').click();
    assert.equal(await page.evaluate(() => state.edit.multiSelect), false);
    await click('undoEdit'); assert.equal(await form(), original);
    await click('toggleChipSelection'); await chip(1).tap();
    await page.evaluate(() => go({ name: 'week', id: 'week1' })); await open();
    assert.equal(await page.evaluate(() => state.edit.multiSelect), false);
    console.log('PASS select all, deselection, cancel, direct edit and navigation reset selection without unintended deletion');

    await click('toggleChipSelection'); await click('selectAllChips'); await click('deleteSelectedChips');
    assert.equal(await form(), '');
    assert.equal(await page.locator('[data-act=toggleChipSelection]').isDisabled(), true);
    await click('undoEdit'); assert.equal(await form(), original);
    await click('redoEdit'); assert.equal(await form(), '');
    await page.evaluate(() => flushSaves()); await page.reload();
    await page.waitForFunction(() => state.weeks.length === 2 && !pendingSaves); await open();
    assert.equal(await form(), '');
    const preserved = await page.evaluate(() => [songOf('original').lastForm, entryForm(weekOf('week2').songs[0])]);
    assert.deepEqual(preserved, [original, original]);
    await click('pdfWeek'); await page.locator('#pdfDownload[href]').waitFor();
    assert.match(await page.locator('.preview-check').first().textContent(), /송폼 없음/);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.rejections), []);
    console.log('PASS delete all persists as empty after reload and PDF preview; library and other week stay intact');
    console.log('Artifacts:', output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
