/* Run with Playwright installed: node tests/regression.cjs
   CHROME_PATH optionally selects a system Chromium executable.
   All data lives in an isolated browser context; no personal browser is used. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'songform-regression-'));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    await context.addInitScript(() => { window.unhandled = []; window.addEventListener('unhandledrejection', e => window.unhandled.push(String(e.reason))); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://songform.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://songform.test/');
    await page.waitForFunction(() => typeof db !== 'undefined' && db && !pendingSaves);
    // Legacy data: two weeks reuse one library song, including an empty weekly form.
    await page.evaluate(async () => {
      const sheets = [];
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('canvas'); c.width = 600; c.height = 840;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 840);
        x.fillStyle = '#111'; x.font = '30px sans-serif'; x.fillText(`Sample score - page ${i + 1}`, 70, 180);
        for (let line = 0; line < 20; line++) x.fillRect(60, 240 + line * 22, 480, 1);
        sheets.push({ blob: await canvasToBlob(c), w: 600, h: 840 });
      }
      const song = { id: 'original', title: '샘플 찬양', key: 'G', sheets, labels: [],
        lastForm: 'V1-C', tempo: 'mid', placement: { x: .5, y: .1, size: .04, page: 0 } };
      await idbPut('songs', song);
      await idbPut('weeks', { id: 'week1', date: '2026-10-04', songs: [{ id: 'entry1', songId: song.id, form: '' }], target: 20 });
      await idbPut('weeks', { id: 'week2', date: '2026-10-11', songs: [{ id: 'entry2', songId: song.id, form: 'V1-C' }], target: 20 });
    });
    await page.reload();
    await page.waitForFunction(() => state.weeks.length === 2 && !pendingSaves);
    let migration = await page.evaluate(() => ({ count: Object.keys(state.songs).length,
      ids: state.weeks.map(w => w.songs[0].songId), forms: state.weeks.map(w => entryForm(w.songs[0])), library: librarySongs().length }));
    assert.equal(migration.count, 3); assert.equal(new Set(migration.ids).size, 2);
    assert.deepEqual(migration.forms, ['', 'V1-C']); assert.equal(migration.library, 1);
    await page.reload();
    await page.waitForFunction(() => state.weeks.length === 2 && !pendingSaves);
    assert.equal(await page.evaluate(() => Object.keys(state.songs).length), 3, 'migration must be idempotent');
    console.log('PASS existing data migrated without losing empty forms or library originals');

    await page.locator('[data-act=openWeek][data-id=week1]').click();
    await page.getByRole('button', { name: '콘티 제목 수정' }).click();
    await page.locator('#askIn').fill('10월 1주차 청년예배');
    await page.locator('#askOk').click();
    await page.waitForFunction(() => weekOf('week1').title === '10월 1주차 청년예배' && !pendingSaves);
    // Empty form must not silently fall back to a library form in the preview.
    await page.locator('[data-act=pdfWeek]').click();
    await page.locator('#pdfDownload[href]').waitFor();
    assert.match(await page.locator('.preview-check').first().textContent(), /송폼 없음/);
    assert.equal(await page.locator('.preview-page').count(), 3);
    await page.locator('#pvNone').click();
    await page.waitForFunction(() => document.querySelector('#pdfDownload').getAttribute('aria-disabled') === 'true');
    await page.locator('#pvAll').click();
    await page.locator('#pdfDownload[href]').waitFor();
    await page.locator('input[data-page="1"]').uncheck();
    await page.waitForFunction(() => document.querySelector('#pvCount').textContent === '2 / 3쪽 포함' && !pendingSaves);
    await page.locator('#pdfName').fill('같은 제목');
    await page.locator('#pdfDownload[href]').waitFor();
    const d1Promise = page.waitForEvent('download');
    await page.locator('#pdfDownload').click(); const d1 = await d1Promise;
    await d1.saveAs(path.join(output, 'before.pdf'));
    assert.match(d1.suggestedFilename(), /^같은 제목_\d{8}_\d{6}_\d{3}\.pdf$/);
    await page.locator('#pvClose').click();
    await page.locator('.entry .thumb').click();
    await page.locator('[data-act=typeForm]').first().click();
    await page.locator('#askIn').fill('Intro-V1-Cx2-outro'); await page.locator('#askOk').click();
    await page.locator('[data-act=undoEdit]').click();
    assert.equal(await page.evaluate(() => currentForm()), '');
    await page.locator('[data-act=redoEdit]').click();
    assert.equal(await page.evaluate(() => currentForm()), 'Intro-V1-Cx2-outro');
    // Page deletion and undo must preserve both page mapping and output exclusions.
    await page.evaluate(() => { state.edit.song.placement.page = 2; saveSong(state.edit.song); });
    await page.locator('[data-act=removePage]').click(); await page.locator('#cOk').click();
    assert.equal(await page.evaluate(() => state.edit.song.placement.page), 1);
    await page.locator('[data-act=undoEdit]').click();
    assert.equal(await page.evaluate(() => state.edit.song.sheets.length), 3);
    assert.equal(await page.evaluate(() => state.edit.song.placement.page), 2);
    // Restore form to the front page via the UI's auto-position action.
    await page.locator('[data-act=autoSlot]').click();
    await page.locator('[data-act=pdfWeek]').click();
    await page.locator('#pdfDownload[href]').waitFor();
    assert.equal(await page.locator('input[data-page="1"]').isChecked(), false, 'page exclusion persists');
    assert.equal(await page.locator('#pdfName').inputValue(), '같은 제목');
    const d2Promise = page.waitForEvent('download');
    await page.locator('#pdfDownload').click(); const d2 = await d2Promise;
    await d2.saveAs(path.join(output, 'after.pdf'));
    assert.notEqual(d1.suggestedFilename(), d2.suggestedFilename());
    assert.notEqual(hash(path.join(output, 'before.pdf')), hash(path.join(output, 'after.pdf')));
    await page.locator('.sheet').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'preview-mobile.png') });
    await page.locator('#pvClose').click();
    const isolation = await page.evaluate(() => ({ other: songOf(weekOf('week2').songs[0].songId), original: songOf('original') }));
    assert.equal(isolation.other.lastForm, 'V1-C'); assert.equal(isolation.original.lastForm, 'V1-C');
    assert.equal(isolation.other.placement.page, 0); assert.equal(isolation.other.sheets.length, 3);
    console.log('PASS distinct filenames and changed PDF bytes after editing, selected pages preserved, undo/redo and isolation');

    await page.reload();
    await page.waitForFunction(() => state.weeks.length === 2 && !pendingSaves);
    const saved = await page.evaluate(() => {
      const w = weekOf('week1'); return { title: w.title, form: entryForm(w.songs[0]), excluded: songOf(w.songs[0].songId).sheets[1].excluded, last: w.lastExport };
    });
    assert.equal(saved.title, '10월 1주차 청년예배'); assert.equal(saved.form, 'Intro-V1-Cx2-outro');
    assert.equal(saved.excluded, true); assert.equal(saved.last.fileName, d2.suggestedFilename());
    console.log('PASS reload retains title, form, exclusions and export history');

    // Force a real failed IndexedDB transaction, verify retry and export gating.
    await page.locator('[data-act=openWeek][data-id=week1]').click();
    await page.evaluate(async () => { db.close(); const w = weekOf('week1'); w.title = '저장 재시도 확인'; await saveWeek(w); });
    assert.match(await page.locator('#saveStatus').textContent(), /저장 실패/);
    await page.locator('[data-act=pdfWeek]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('저장에 실패'));
    assert.equal(await page.locator('#pdfDownload').count(), 0);
    await page.locator('[data-act=retrySave]').click();
    await page.waitForFunction(() => failedWrites.size === 0 && pendingSaves === 0);
    assert.match(await page.locator('#saveStatus').textContent(), /저장됨/);
    console.log('PASS failed saves block export and can be retried');

    // Copy through UI, then edit only the new week's arrangement.
    await page.locator('[data-act=weekMenu]').click();
    await page.getByRole('button', { name: /이 콘티 복사해서/ }).click();
    await page.waitForFunction(() => state.weeks.length === 3 && !pendingSaves);
    const copy = await page.evaluate(() => {
      const w = weekOf(state.view.id); const original = weekOf('week1');
      return { id: w.id, song: w.songs[0].songId, oldSong: original.songs[0].songId, form: entryForm(w.songs[0]) };
    });
    assert.notEqual(copy.song, copy.oldSong); assert.equal(copy.form, 'Intro-V1-Cx2-outro');
    console.log('PASS copied week owns independent arrangement');

    // Import three files, group two as a single song, preserve one standalone song.
    await page.locator('[data-act=addSong]').click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /악보 사진 넣기 ·/ }).click();
    const chooser = await chooserPromise;
    const png = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 420;
      const x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 300, 420);
      x.fillStyle = 'black'; x.fillText('Score', 100, 100);
      return Array.from(Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0)));
    }));
    await chooser.setFiles([1,2,3].map(i => ({ name: `악보${i}.png`, mimeType: 'image/png', buffer: png })));
    await page.locator('[data-join="1"]').check();
    await page.locator('[data-title="0"]').fill('두 장 찬양');
    await page.locator('#importConfirm').click();
    await page.locator('#ttOk').click();
    await page.waitForFunction(() => !pendingSaves);
    const grouped = await page.evaluate(() => weekOf(state.view.id).songs.map(e => songOf(e.songId).sheets.length));
    assert.deepEqual(grouped, [3,2,1]);
    await page.locator('.entry .thumb').first().click();
    await page.locator('#fTitle').fill('바꾸고 바로 다음 곡');
    await page.locator('[data-act=navSong][data-dir="1"]').click();
    await page.locator('[data-act=typeForm]').first().click();
    await page.locator('#askIn').fill('V2-Cx3'); await page.locator('#askOk').click();
    await page.locator('[data-act=navSong][data-dir="-1"]').click();
    assert.equal(await page.locator('#fTitle').inputValue(), '바꾸고 바로 다음 곡');
    await page.locator('[data-act=navSong][data-dir="1"]').click();
    assert.equal(await page.evaluate(() => currentForm()), 'V2-Cx3');
    await page.locator('[data-act=back]').click();
    console.log('PASS editing title then immediately switching songs retains both edits');
    await page.locator('[data-act=home]').click();
    await page.locator('[data-act=openLibrary]').click();
    await page.locator('#librarySearch').fill('두 장');
    assert.equal(await page.locator('[data-act=openSong]').count(), 1);
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'library-mobile.png'), fullPage: true });
    console.log('PASS multi-page import grouping and library search');
    // Backup round trip retains exclusion flags and independent arrangements.
    const backupDownloadPromise = page.waitForEvent('download');
    await page.evaluate(() => backupExport());
    const backupDownload = await backupDownloadPromise;
    const backupPath = path.join(output, 'backup.json'); await backupDownload.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const backedWeek = backup.weeks.find(w => w.id === 'week1');
    assert.equal(backup.songs.find(s => s.id === backedWeek.songs[0].songId).sheets[1].excluded, true);
    await page.evaluate(async data => {
      await flushSaves(); await idbClear('songs'); await idbClear('weeks'); state.songs = {}; state.weeks = [];
      await restoreBackup(data);
    }, backup);
    assert.equal(await page.evaluate(() => songOf(weekOf('week1').songs[0].songId).sheets[1].excluded), true);
    assert.equal(await page.evaluate(() => weekOf('week1').lastExport.fileName), d2.suggestedFilename());
    const originalWeekSong = await page.evaluate(() => weekOf('week1').songs[0].songId);
    await page.evaluate(async () => { await deleteSongEverywhere(songOf('original')); });
    assert.equal(await page.evaluate(id => !!songOf(id), originalWeekSong), true, 'deleting library original must retain prior arrangements');
    console.log('PASS backup round trip and library deletion preserve weekly arrangements');
    // Sharing must be called while user activation is present, using the preview file.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({files}) => {
        window.shared = { name: files[0].name, size: files[0].size, active: navigator.userActivation.isActive };
      }});
      go({ name: 'week', id: 'week1' });
    });
    await page.locator('[data-act=pdfWeek]').click(); await page.locator('#pdfDownload[href]').waitFor();
    const preparedName = await page.locator('#pdfDownload').getAttribute('download');
    await page.locator('#pdfShare').click();
    const shared = await page.evaluate(() => window.shared);
    assert.equal(shared.name, preparedName); assert.equal(shared.active, true); assert.ok(shared.size > 1000);
    await page.locator('#pvClose').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'week-desktop.png') });
    console.log('PASS share uses the prepared file within user activation');
    // Reuse forms across weeks even when system clipboard permission is denied.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
        readText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      }});
      go({ name: 'week', id: 'week1' });
    });
    await page.locator('.entry .thumb').first().click();
    const sourceForm = await page.evaluate(() => currentForm());
    const sourceRecord = await page.evaluate(() => JSON.stringify(songRecord(state.edit.song)));
    await page.locator('[data-act=copyForm]').click();
    await page.waitForFunction(() => !!state.formClipboard && !pendingSaves);
    assert.equal(await page.evaluate(() => state.formClipboard.text), sourceForm);
    await page.reload();
    await page.waitForFunction(() => state.loaded && !pendingSaves && !!state.formClipboard);
    assert.equal(await page.evaluate(() => state.formClipboard.text), sourceForm, 'app clipboard survives reload');
    await page.locator('[data-act=openWeek][data-id=week2]').click();
    await page.locator('.entry .thumb').first().click();
    const targetBefore = await page.evaluate(() => ({ form: currentForm(), title: state.edit.song.title,
      labels: state.edit.song.labels, placement: state.edit.song.placement, pages: state.edit.song.sheets.length }));
    await page.locator('[data-act=pasteForm]').click();
    assert.equal(await page.locator('#pasteText').inputValue(), sourceForm);
    await page.locator('#readClipboard').click();
    await page.waitForFunction(() => document.querySelector('#pasteStatus').textContent.includes('길게 누르거나'));
    // Denial must leave the available app clipboard content intact.
    assert.equal(await page.locator('#pasteText').inputValue(), sourceForm);
    await page.locator('#pasteCancel').click();
    assert.equal(await page.evaluate(() => currentForm()), targetBefore.form);
    await page.locator('[data-act=pasteForm]').click();
    await page.locator('#pasteReplace').click();
    await page.waitForFunction(() => !state.sheet && !pendingSaves);
    assert.equal(await page.evaluate(() => currentForm()), sourceForm);
    const targetAfter = await page.evaluate(() => ({ title: state.edit.song.title,
      labels: state.edit.song.labels, placement: state.edit.song.placement, pages: state.edit.song.sheets.length }));
    const {form: previousForm, ...untouched} = targetBefore;
    assert.deepEqual(targetAfter, untouched);
    assert.equal(await page.evaluate(() => JSON.stringify(songRecord(songOf(weekOf('week1').songs[0].songId)))), sourceRecord);
    await page.locator('[data-act=undoEdit]').click();
    assert.equal(await page.evaluate(() => currentForm()), previousForm);
    await page.locator('[data-act=pasteForm]').click(); await page.locator('#pasteAppend').click();
    await page.waitForFunction(() => !state.sheet && !pendingSaves);
    assert.equal(await page.evaluate(() => currentForm()), `${previousForm}-${sourceForm}`);
    await page.locator('[data-act=undoEdit]').click();
    console.log('PASS copy/paste, persistent app clipboard, permission-denied fallback, cancellation, append and undo');

    await page.locator('[data-act=browseForms]').click();
    assert.match(await page.locator('.form-history-item').first().textContent(), /같은 곡/);
    await page.locator('#formHistorySearch').fill('no matching song');
    assert.equal(await page.locator('.form-history-item').count(), 0);
    await page.locator('#formHistorySearch').fill('2026-10-04');
    assert.equal(await page.locator('.form-history-item').count(), 1);
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'form-history-mobile.png') });
    await page.locator('.form-history-item').click();
    assert.equal(await page.locator('#pasteText').inputValue(), sourceForm);
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'form-paste-mobile.png') });
    await page.locator('#pasteReplace').click();
    await page.waitForFunction(() => !state.sheet && !pendingSaves);
    await page.reload();
    await page.waitForFunction(() => state.loaded && !pendingSaves);
    assert.equal(await page.evaluate(() => entryForm(weekOf('week2').songs[0])), sourceForm);
    console.log('PASS history search, matching-song priority and reused form persists after reload');

    await page.locator('[data-act=openWeek][data-id=week2]').click();
    await page.locator('[data-act=addSong]').click();
    await page.getByRole('button', { name: /이전 콘티에서 곡 가져오기/ }).click();
    await page.locator('#formHistorySearch').fill('2026-10-04');
    await page.locator('.form-history-item').click();
    await page.locator('#historyAdd').click();
    await page.waitForFunction(() => !state.sheet && !pendingSaves && weekOf('week2').songs.length === 2);
    const reusedSong = await page.evaluate(() => {
      const entries = weekOf('week2').songs, source = songOf(weekOf('week1').songs[0].songId);
      const imported = songOf(entries[entries.length-1].songId);
      return { importedId: imported.id, sourceId: source.id, form: imported.lastForm,
        pages: imported.sheets.length, expectedPages: source.sheets.length, owner: imported.ownerWeekId };
    });
    assert.notEqual(reusedSong.importedId, reusedSong.sourceId); assert.equal(reusedSong.owner, 'week2');
    assert.equal(reusedSong.form, sourceForm); assert.equal(reusedSong.pages, reusedSong.expectedPages);
    await page.locator('.entry .thumb').last().click();
    await page.locator('[data-act=addBlock][data-name=B]').click();
    assert.equal(await page.evaluate(() => entryForm(weekOf('week1').songs[0])), sourceForm);
    console.log('PASS individual song import copies score/form independently without altering source week');

    // Dismissing text-entry resolves its promise and must not persist a value.
    await page.evaluate(() => { window.dismissed = false; askText('취소 테스트').then(v => window.dismissed = v === null); });
    await page.locator('#askNo').click();
    assert.equal(await page.evaluate(() => window.dismissed), true);
    assert.deepEqual(await page.evaluate(() => window.unhandled), []);
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught browser errors');
    console.log(`Artifacts: ${output}`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
