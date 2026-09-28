/* Focused regressions for mobile score scrolling and interrupted image imports.
   Run like regression.cjs with Playwright and optional CHROME_PATH. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}) });
  try {
    const context = await browser.newContext({ viewport: {width:390,height:844}, isMobile:true, hasTouch:true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.addInitScript(() => { window.rejections=[]; window.addEventListener('unhandledrejection', e => window.rejections.push(String(e.reason))); });
    await page.route('http://songform.test/**', route => route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://songform.test/');
    await page.waitForFunction(() => state.loaded && !pendingSaves);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=840;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='white'; ctx.fillRect(0,0,600,840);
      ctx.fillStyle='black'; ctx.font='24px sans-serif'; ctx.fillText('Scroll test score',90,100);
      const blob=await canvasToBlob(canvas);
      window.goodImage=new File([blob],'score.jpg',{type:'image/jpeg'});
      const week={id:'week',date:'2026-10-04',songs:[],target:20}; state.weeks=[week];
      for (let i=1;i<=2;i++) {
        const song={id:'song'+i,ownerWeekId:week.id,title:'악보 '+i,lastForm:'Intro-V1-C',key:'G',tempo:'mid',
          labels:[],placement:{x:.5,y:.3,size:.035,page:0},sheets:[{blob,w:600,h:840}]};
        state.songs[song.id]=song; week.songs.push({id:'entry'+i,songId:song.id,form:song.lastForm});
        await saveSong(song);
      }
      await flushSaves(); go({name:'song',songId:'song1',weekId:'week',entryId:'entry1'});
    });
    await page.waitForFunction(() => state.edit?.boxes?.form);
    const original = await page.evaluate(() => JSON.stringify(songRecord(state.edit.song)));
    const cdp=await context.newCDPSession(page);
    const swipe=async (x,y,dy) => {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
      for(let i=1;i<=8;i++) {
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*i/8,id:1}]});
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    const canvasPoint=async (x,y) => page.locator('#cv').evaluate((cv,p)=>{const r=cv.getBoundingClientRect();return{x:r.x+r.width*p.x,y:r.y+r.height*p.y};},{x,y});
    let point=await canvasPoint(.5,.3);
    await swipe(point.x,point.y,-160);
    await page.waitForFunction(() => scrollY>60);
    assert.equal(await page.evaluate(() => JSON.stringify(songRecord(state.edit.song))),original);
    assert.equal(await page.evaluate(() => state.edit.undo?.length || 0),0);
    console.log('PASS touch swiping on song-form text scrolls without changing annotations');
    await page.evaluate(() => scrollTo(0,0));
    // Enter explicit move mode; blank space must not grab the song form.
    await page.locator('[data-act=toggleMove]').click();
    await page.waitForFunction(() => state.edit.boxes?.form);
    const gesture=async (x,y,dx,dy,end='pointerup') => page.locator('#cv').evaluate((cv,g)=>{
      const r=cv.getBoundingClientRect(); const px=r.x+r.width*g.x,py=r.y+r.height*g.y;
      const event=(type,x,y)=>cv.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:7,pointerType:'touch',isPrimary:true,button:0,clientX:x,clientY:y}));
      event('pointerdown',px,py);event('pointermove',px+g.dx,py+g.dy);event(g.end,px+g.dx,py+g.dy);
    },{x,y,dx,dy,end});
    await gesture(.15,.7,20,-50);
    assert.equal(await page.evaluate(() => JSON.stringify(songRecord(state.edit.song))),original);
    await gesture(.5,.3,30,30,'pointercancel');
    assert.equal(await page.evaluate(() => JSON.stringify(songRecord(state.edit.song))),original);
    assert.equal(await page.evaluate(() => state.edit.undo?.length || 0),0);
    // Successful explicit drag commits one edit, and remains undoable.
    await gesture(.5,.3,35,30);
    await page.waitForFunction(() => !pendingSaves);
    assert.ok(await page.evaluate(() => state.edit.song.placement.x>.5));
    assert.equal(await page.evaluate(() => state.edit.undo.length),1);
    await page.locator('[data-act=undoEdit]').click();
    assert.equal(await page.evaluate(() => state.edit.song.placement.x),.5);
    await page.locator('[data-act=toggleLabel]').click();
    await gesture(.2,.7,0,0,'pointercancel');
    assert.equal(await page.evaluate(() => state.edit.song.labels.length),0);
    await gesture(.2,.7,0,0);
    assert.equal(await page.evaluate(() => state.edit.song.labels.length),1);
    await page.locator('[data-act=finishScoreEdit]').click();
    assert.equal(await page.evaluate(() => state.edit.mode),'scroll');
    console.log('PASS explicit move only grabs annotations, cancelled gestures do not edit, label placement and undo work');

    // A later invalid file must not leave an earlier valid page half imported.
    const failure=await page.evaluate(async () => {
      const song=state.edit.song, before=song.sheets.length, history=state.edit.undo.length;
      try { await appendSongPages(song,[window.goodImage,new File(['broken'],'broken.png',{type:'image/png'})],state.edit); }
      catch(error) {return{message:error.message,before,after:song.sheets.length,history,afterHistory:state.edit.undo.length};}
    });
    assert.match(failure.message,/broken.png/);assert.equal(failure.before,failure.after);assert.equal(failure.history,failure.afterHistory);
    const nullBlob=await page.evaluate(async () => {
      const native=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(fn){fn(null);};
      try {await prepareSheet(window.goodImage);} catch(error){return error.message;} finally {HTMLCanvasElement.prototype.toBlob=native;}
    });
    assert.match(nullBlob,/이미지 변환에 실패/);
    const tall=await page.evaluate(async () => {
      const canvas=document.createElement('canvas');canvas.width=300;canvas.height=10000;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,300,10000);
      const sheet=await prepareSheet(new File([await canvasToBlob(canvas)],'long.jpg',{type:'image/jpeg'}));
      return{w:sheet.w,h:sheet.h,size:sheet.blob.size};
    });
    assert.ok(tall.w<=1800&&tall.h<=4096&&tall.size>0);
    console.log('PASS corrupt or unencodable images leave pages intact; long screenshots have bounded canvas dimensions');

    // Reproduce switching songs while an image picker is still outstanding.
    const switched=await page.evaluate(async () => {
      const native=pickFiles; let resolveFiles;
      pickFiles=()=>new Promise(resolve=>resolveFiles=resolve);
      const original=state.edit.song, before=original.sheets.length, other=songOf('song2').sheets.length;
      const adding=ACTIONS.addPage();
      go({name:'song',songId:'song2',weekId:'week',entryId:'entry2'});
      resolveFiles([window.goodImage]);
      try {await adding;} finally {pickFiles=native;}
      return{before,after:original.sheets.length,other,otherAfter:songOf('song2').sheets.length,current:state.edit.song.id};
    });
    assert.equal(switched.after,switched.before+1);assert.equal(switched.other,switched.otherAfter);assert.equal(switched.current,'song2');
    const retried=await page.evaluate(async()=>{
      const native=pickFiles, before=state.edit.song.sheets.length;
      pickFiles=async()=>[new File(['broken'],'bad.png',{type:'image/png'})];
      try{await ACTIONS.addPage();}catch(_){}
      const unlocked=!imageImportBusy;
      pickFiles=async()=>[window.goodImage];
      try{await ACTIONS.addPage();}finally{pickFiles=native;}
      return{unlocked,before,after:state.edit.song.sheets.length};
    });
    assert.equal(retried.unlocked,true);assert.equal(retried.after,retried.before+1);
    console.log('PASS image import stays with the intended song across navigation and can retry after failure');
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'songform-touch-'));
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(folder,'scroll-mode.png'),animations:'disabled'});
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.rejections),[]);
    console.log('Artifacts:',folder);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
