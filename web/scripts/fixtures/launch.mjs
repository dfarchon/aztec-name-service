/** Read-only fixture; policy changes exercise the real reader eligibility method and rendered controls. */
export async function installLaunchFixture(page) {
  await page.evaluate(async () => {
    const source=await(await fetch('/src/App.tsx')).text();
    const path=source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session=await import(path),reader=session.getSession().reader;
    if(!reader)throw Error('Reader must be connected');
    const original=await reader.getConfig();
    const launch={minPublicLength:7,paused:false,maxRenewAhead:0n};
    window.launchFixture={reader,session,launch,reserved:false};
    reader.getConfig=async()=>({...original,feeToken:reader.registry.constructor.ZERO,treasury:reader.registry.constructor.ZERO,annualPrice:0n,lengthPrices:{three:0n,four:0n},launch:{...launch}});
    reader.getName=async()=>({generation:0,revision:0,expiresAt:0n,owner:reader.registry.constructor.ZERO});
    reader.getLegacyName=async()=>undefined;
    reader.isReserved=async()=>window.launchFixture.reserved;
    const account=reader.registry;
    await session.connectExternal({getChainInfo:async()=>({chainId:{toBigInt:()=>reader.deployment.chainId},version:{toBigInt:()=>reader.deployment.rollupVersion}}),getAccounts:async()=>[{alias:'Launch read-only fixture',item:account}],getContractMetadata:async()=>({}),registerContract:async()=>{},createAuthWit:async()=>{throw Error('Free fixture must not authorize token transfer');},sendTx:async()=>{throw Error('Read-only fixture cannot broadcast');}},{disconnect:async()=>{},onDisconnect:()=>()=>{}});
    location.hash='/name/seventh';
  });
}
