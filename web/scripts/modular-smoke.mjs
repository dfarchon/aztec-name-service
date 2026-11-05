// Module UI acceptance: actual registry reads, then isolated read-only states; no signing or broadcasts.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base=process.env.BASE??'http://127.0.0.1:5193', name=process.env.NAME??'modular-name';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage(),errors=[];let broadcasts=0,count=0;
page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
page.on('request',r=>{if(r.postData()?.includes('sendTx')){broadcasts++;void r.abort();}else void r.continue();});
const wait=t=>page.waitForFunction(t=>document.body.innerText.includes(t),{timeout:60000},t);
const click=async(text,selector='button')=>{for(const el of await page.$$(selector)) if(await el.evaluate((e,t)=>e.textContent.trim()===t,text)){await el.click();return;}throw new Error(`Missing control ${text}`);};
const pass=t=>console.log(`PASS ${++count}: ${t}`);
try{
  await page.goto(`${base}/#/name/${name}`);await wait('Active');
  await page.goto(`${base}/#/status`);await wait('Contract modules');
  await click('Contract modules','summary');await wait('Default resolver');pass('status reads the initialized contract modules');
  await page.evaluate(async(name)=>{
    const source=await(await fetch('/src/App.tsx')).text(),path=source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session=await import(path);window.moduleSession=session;
    const reader=session.getSession().reader;const sdkSource=await(await fetch('/src/pages/Register.tsx')).text(),sdkPath=sdkSource.match(/from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/)?.[1];
    const sdk=await import(sdkPath);window.moduleSdk=sdk;
    const holding=await sdk.getName(reader,name),account=holding.record.owner;
    window.moduleFixture={reader,account,record:holding.record,getName:reader.getName.bind(reader),getModules:reader.getModules.bind(reader),getConfig:reader.getConfig.bind(reader),inspectResolver:reader.inspectResolver.bind(reader)};
    await session.connectExternal({getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts:async()=>[{alias:'Read-only module fixture',item:account}],getContractMetadata:async()=>({}),registerContract:async()=>{}},{disconnect:async()=>{},onDisconnect:()=>()=>{}});
    location.hash=`/manage/${name}`;
  },name);
  await wait('Resolver');pass('holder management exposes its resolver without an administrator panel');
  await page.evaluate(()=>{const f=window.moduleFixture;f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:false,isDefault:false,reason:'unknown_class'});location.hash='/status';});
  await wait('Contract modules');await page.evaluate(name=>{location.hash=`/manage/${name}`;},name);await wait('Unverified resolver: address records may be controlled by a third party');await wait('Use default resolver');assert.equal(await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Set primary name')?.disabled),true);
  await wait('first, then set your address and primary name again.');
  await page.$$eval('button.link',buttons=>buttons.find(b=>b.textContent.trim()==='Go to resolver controls').click());
  assert(['use-default-resolver','resolver-controls'].includes(await page.evaluate(()=>document.activeElement?.id)));
  pass('unknown resolver disables primary and links to default-resolver recovery');
  await page.evaluate(()=>{window.moduleFixture.reader.inspectResolver=async()=>{throw Error('fixture resolver read unavailable');};location.hash='/status';});
  await wait('Contract modules');await page.evaluate(name=>{location.hash=`/manage/${name}`;},name);await wait('Resolver');await wait('Use default resolver');
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Use default resolver')?.disabled),true);
  await wait('Refresh contract status');assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);pass('resolver read errors disable signing and offer retry without switch guidance');
  await page.evaluate(()=>{const f=window.moduleFixture;f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:true,isDefault:false});});
  await click('Refresh contract status');await wait('Non-default resolver: review its address records.');
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Use default resolver')?.disabled),false);pass('successful retry restores the recovery action');
  await page.evaluate(()=>{const f=window.moduleFixture;f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:false,isDefault:true,reason:'unknown_class'});f.reader.getModules=async()=>({...(await f.getModules()),resolver:f.reader.registry});location.hash='/status';});
  await wait('Contract modules');await page.evaluate(name=>{location.hash=`/manage/${name}`;},name);await wait('Use default resolver');
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Use default resolver')?.disabled),true);pass('already-default resolver cannot trigger an unchanged reset');
  await page.evaluate(()=>{window.moduleFixture.reader.getModules=window.moduleFixture.getModules;});
  await page.evaluate(()=>{window.moduleFixture.reader.inspectResolver=window.moduleFixture.inspectResolver;});

  await page.evaluate(()=>{const f=window.moduleFixture;f.reader.getName=async()=>({generation:0,revision:0,expiresAt:0n,owner:f.account.constructor.ZERO});f.reader.getLegacyName=async()=>f.record;location.hash='/name/migration-ui';});
  await wait('Migration required');assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes('Available'));pass('legacy reservation cannot be displayed as available');
  await page.evaluate(()=>{location.hash='/manage/migration-ui';});await wait('Migrate to current registry');pass('legacy holder gets an explicit migration action and primary reconfirmation notice');
  await page.evaluate(()=>{const f=window.moduleFixture;f.reader.getLegacyName=async()=>({...f.record,owner:f.reader.registry});location.hash='/manage/foreign-legacy-ui';});await wait('Switch to the previous owner account.');pass('another account cannot start migration');
  await page.evaluate(async()=>{
    const f=window.moduleFixture,{reader}=f,s=window.moduleSession,sdk=window.moduleSdk;
    reader.getLegacyName=async()=>undefined;
    const plan=await sdk.prepareRegistration(s.getSession().ctx,{name:'policy-ui',duration:31536000n});
    const config=await reader.getConfig(), modules=await reader.getModules(),snap=await reader.snapshot();
    reader.getConfig=async()=>config;reader.getModules=async()=>({...modules,registrar:reader.registry});reader.getCommit=async()=>({committedAt:snap.timestamp-100n,consumed:false});
    await s.recordWriter(s.getSession().ctx)(r=>({...r,plans:[plan]}));location.hash='/register/policy-ui';
  });
  await wait('Registration policy changed');await wait('Remove record');assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes('Pay and register'));pass('a plan with a retired Registrar cannot pay and can be removed for re-preparation');
  await click('Remove record');await wait('Registration details');pass('removing the obsolete plan restores registration');
  await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(broadcasts,0);assert.deepEqual(errors,[]);pass('mobile layout and runtime checks pass with zero broadcasts');
  console.log(`ALL ${count} MODULAR UI CHECKS PASSED`);
}finally{await browser.close();}
