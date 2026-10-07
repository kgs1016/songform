/* Run like regression.cjs. Verify previous-form shortcuts through the UI in isolated storage. */
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
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.addInitScript(() => { window.rejections = []; window.addEventListener('unhandledrejection', e => window.rejections.push(String(e.reason))); });
    await page.route('http://songform.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://songform.test/');
    await page.waitForFunction(() => state.loaded && !pendingSaves);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=840;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='white'; ctx.fillRect(0,0,600,840);
      const blob=await canvasToBlob(canvas);
      const base={title:'주의 사랑',key:'G',tempo:'mid',labels:[{page:0,text:'V1',x:.1,y:.3,size:.03}],
        placement:{x:.5,y:.1,size:.03,page:0},sheets:[{blob,w:600,h:840}]};
      await idbPut('songs',{...base,id:'root',lastForm:'V1-C'});
      for (const [id,date,title,form,origin] of [
        ['old','2026-09-20','다르게 적었던 제목','V1-Cx2','root'],
        ['recent','2026-09-27','주의 사랑','Intro-V1-V2-Cx2-outro','root'],
        ['title','2026-10-01','주의 사랑','V4-C','other-root'],
        ['empty','2026-10-02','주의 사랑','','root'],
        ['current','2026-10-04','주의 사랑','','root'],
        ['future','2026-10-11','주의 사랑','V3-C','root'],
      ]) {
        await idbPut('songs',{...base,id,ownerWeekId:id,sourceSongId:origin,title,lastForm:form});
        await idbPut('weeks',{id,date,target:20,songs:[{id:'entry-'+id,songId:id,form}]});
      }
      await idbPut('songs',{...base,id:'new',title:'새로운 찬양',lastForm:''});
      await idbPut('songs',{...base,id:'generic1',title:'악보 1',lastForm:'V1'});
      await idbPut('songs',{...base,id:'generic2',title:'악보 1',lastForm:''});
      await idbPut('songs',{...base,id:'titleOnly',title:'  주의   사랑  ',lastForm:''});
    });
    await page.reload(); await page.waitForFunction(()=>state.loaded&&!pendingSaves);
    const openCurrent=()=>page.evaluate(()=>go({name:'song',songId:'current',weekId:'current',entryId:'entry-current'}));
    await openCurrent();
    const form=()=>page.evaluate(()=>currentForm());
    const click=act=>page.locator(`[data-act=${act}]`).first().click();
    const recent='Intro-V1-V2-Cx2-outro';
    assert.equal(await page.locator('.prior-preview').textContent(),recent);
    assert.equal(await form(),'','opening the song must not auto-apply a prior arrangement');
    assert.equal(await page.locator('#priorFormSource').inputValue(),'week:recent:entry-recent');
    const options=await page.locator('#priorFormSource option').evaluateAll(xs=>xs.map(x=>x.value));
    assert.deepEqual(options,['week:recent:entry-recent','week:old:entry-old','library:root','week:title:entry-title']);
    const pos=await page.evaluate(()=>({prior:document.querySelector('.prior-form').getBoundingClientRect().top,score:document.querySelector('#stage').getBoundingClientRect().top}));
    assert(pos.prior<pos.score);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const output=fs.mkdtempSync(path.join(os.tmpdir(),'songform-prior-'));
    await page.screenshot({path:path.join(output,'previous-form-mobile.png'),animations:'disabled'});
    const before=await page.evaluate(()=>JSON.stringify({labels:state.edit.song.labels,placement:state.edit.song.placement,sheets:state.edit.song.sheets.map(s=>[s.w,s.h,s.blob.size])}));
    await click('usePriorForm'); assert.equal(await form(),recent);
    assert.equal(await page.locator('#sheetBg').count(),0,'direct reuse should not need another dialog');
    assert.equal(await page.locator('[data-act=usePriorForm]').isDisabled(),true);
    assert.equal(await page.evaluate(()=>JSON.stringify({labels:state.edit.song.labels,placement:state.edit.song.placement,sheets:state.edit.song.sheets.map(s=>[s.w,s.h,s.blob.size])})),before);
    await click('undoEdit'); assert.equal(await form(),'');
    await click('redoEdit'); assert.equal(await form(),recent);
    await page.locator('#priorFormSource').selectOption('week:old:entry-old');
    assert.equal(await page.locator('.prior-preview').textContent(),'V1-Cx2');
    assert.equal(await form(),recent);
    await click('editPriorForm');
    assert.equal(await page.locator('#pasteText').inputValue(),'V1-Cx2');
    assert.equal(await page.locator('#readClipboard').count(),0);
    await page.locator('#pasteText').fill('V1-Cx3(함께)');
    assert.equal(await form(),recent);
    await page.locator('#pasteCancel').click(); assert.equal(await form(),recent);
    await click('editPriorForm'); await page.locator('#pasteText').fill('V1-Cx3(함께)');
    await page.locator('#pasteReplace').click(); await page.waitForFunction(()=>!state.sheet&&!pendingSaves);
    assert.equal(await form(),'V1-Cx3(함께)');
    const originals=await page.evaluate(()=>[songOf('old').lastForm,songOf('recent').lastForm,songOf('root').lastForm]);
    assert.deepEqual(originals,['V1-Cx2',recent,'V1-C']);
    await page.reload(); await page.waitForFunction(()=>state.loaded&&!pendingSaves); await openCurrent();
    assert.equal(await form(),'V1-Cx3(함께)');
    console.log('PASS prior records above score, origin priority, future/empty exclusion, direct reuse, edit/cancel, undo, persistence and source preservation');

    await page.locator('#priorFormSource').selectOption('week:title:entry-title');
    assert.match(await page.locator('.prior-meta').textContent(),/같은 제목/);
    await page.evaluate(()=>go({name:'song',songId:'titleOnly'}));
    assert.equal(await page.locator('[data-act=usePriorForm]').count(),1);
    assert.match(await page.locator('.prior-meta').textContent(),/같은 제목/);
    await page.evaluate(()=>go({name:'song',songId:'generic2'}));
    assert.equal(await page.locator('[data-act=usePriorForm]').count(),0);
    await page.evaluate(()=>go({name:'song',songId:'new'}));
    assert.equal(await page.locator('[data-act=usePriorForm]').count(),0);
    assert.equal(await page.locator('.prior-form [data-act=typeForm]').count(),1);
    assert.equal(await page.locator('.prior-form [data-act=hymnForm]').count(),1);
    assert.equal(await page.locator('[data-act=suggest]').isVisible(),false);
    await page.locator('.draft-tools summary').click();
    assert.equal(await page.locator('[data-act=suggest]').isVisible(),true);
    await click('suggest'); await page.locator('#sgNo').click(); assert.equal(await form(),'');
    await page.evaluate(()=>go({name:'week',id:'current'}));
    assert.equal(await page.locator('[data-act=suggestWeek]').isVisible(),false);
    console.log('PASS title-only matching is labelled, generic names do not match, new songs start manually and time-based drafts are secondary');
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.rejections),[]);
    console.log('Artifacts:',output);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
