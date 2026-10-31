import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base=process.env.BASE??'http://127.0.0.1:5195';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(base);await page.waitForSelector('h1');await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark');
 for(const theme of ['dark','light']) {
  if(theme==='light') await page.click('.theme-toggle');
  for(const width of [1280,768,390,320]) {
   await page.setViewport({width,height:900});
   const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,radius:getComputedStyle(document.querySelector('.card')).borderRadius,font:getComputedStyle(document.body).fontFamily,targets:[...document.querySelectorAll('button,nav a,summary')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({text:e.textContent,h:e.getBoundingClientRect().height,w:e.getBoundingClientRect().width}))}));
   assert.equal(result.overflow,false,`${theme} ${width} overflow`);assert.equal(result.radius,'0px');assert.ok(result.font.includes('Fira Sans'));assert.ok(result.targets.every(e=>e.h>=44&&e.w>=44),JSON.stringify(result.targets));
   if(width===1280||width===320) await page.screenshot({path:`/tmp/ans-design-${theme}-${width}.png`,fullPage:true});
  }
  console.log(`PASS ${theme}: desktop/tablet/mobile/320px layout and touch targets`);
 }
 await page.reload();await page.waitForSelector('h1');assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');console.log('PASS theme persists on reload');
 await page.focus('.skip-link');assert.equal(await page.evaluate(()=>document.activeElement.className),'skip-link');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'content');console.log('PASS keyboard skip link preserves route and reaches content');
 await page.focus('input');assert.ok((await page.$eval('input',e=>getComputedStyle(e).boxShadow)).includes('inset'));console.log('PASS field focus uses inset indicator');
 assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
 const fonts=await page.evaluate(async()=>{await Promise.all(['400','600','700'].map(w=>document.fonts.load(`${w} 17px "Fira Sans"`)));await document.fonts.load('italic 400 17px "Fira Sans"');return [...document.fonts].filter(f=>f.family==='Fira Sans').map(f=>f.status);});assert.equal(fonts.length,4);assert.ok(fonts.every(s=>s==='loaded'));console.log('PASS all four self-hosted font faces load');
}finally{await browser.close();}
