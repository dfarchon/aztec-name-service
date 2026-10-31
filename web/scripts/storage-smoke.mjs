// The registration secret must survive before the application sends commit.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage();await page.goto(process.env.BASE??'http://localhost:5179');
  const result=await page.evaluate(async()=>{
    const {RecordStore, deriveKeys}=await import('/src/vault.ts');
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const store=new RecordStore(key,'ans-storage-regression',()=>({}));
    await store.save({secret:123n});
    const roundtrip=(await store.load()).secret===123n;
    const original=Storage.prototype.setItem;
    let rejected=false;
    try {
      Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};
      try {await store.save({secret:456n});} catch(e) {rejected=e.message.includes('Cannot save registration progress');}
    } finally {Storage.prototype.setItem=original;localStorage.removeItem('ans-storage-regression');}
    const saltKey='ans:vault-salt';
    const oldSalt=localStorage.getItem(saltKey);
    const originalGet=Storage.prototype.getItem;
    let blockedRead=false;
    let blockedSalt=false;
    try {
      Storage.prototype.getItem=function(){throw new DOMException('blocked','SecurityError');};
      try {await deriveKeys('local-storage-regression');} catch(e) {blockedRead=e.message.includes('Cannot read wallet encryption settings');}
      Storage.prototype.getItem=originalGet;
      localStorage.removeItem(saltKey);
      Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};
      try {await deriveKeys('local-storage-regression');} catch(e) {blockedSalt=e.message.includes('Cannot save wallet encryption settings');}
    } finally {
      Storage.prototype.getItem=originalGet;
      Storage.prototype.setItem=original;
      if(oldSalt!==null) localStorage.setItem(saltKey,oldSalt);
      else localStorage.removeItem(saltKey);
    }
    return {roundtrip,rejected,blockedRead,blockedSalt};
  });
  assert.ok(result.roundtrip);assert.ok(result.rejected);
  assert.ok(result.blockedRead);assert.ok(result.blockedSalt);
  console.log('PASS encrypted persistence roundtrip');console.log('PASS storage quota failure rejects save');
  console.log('PASS blocked storage rejects wallet key derivation');
  console.log('PASS unsaved salt cannot create unrecoverable wallet encryption keys');
} finally {await browser.close();}
