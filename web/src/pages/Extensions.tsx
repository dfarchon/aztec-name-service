import { useEffect, useRef, useState } from 'react';
import { AnsError, acceptTransfer, formatName, listSubnames, getName, issueSubname, offerTransfer, revokeSubname, setManager, setTextRecord, setResolver, type AnsContext, type Holding, type TxOptions } from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Card, CopyValue, Field, TxLine, useTx } from '../components';
import { translate as t } from '../i18n';
import { date, errorMessage } from '../format';
function address(value: string) { if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new AnsError('invalid_argument', 'Enter a valid Aztec address.'); return AztecAddress.fromStringUnsafe(value); }

export function Extensions({ ctx, holding: h, onDone }: { ctx: AnsContext; holding: Holding; onDone: () => void }) {
  const tx = useTx(), [error,setError] = useState(''), [records,setRecords] = useState<Record<string,string>>({}), [manager,setCurrentManager] = useState(''), [offer,setOffer] = useState<{recipient: AztecAddress;expiresAt:bigint}>();
  const [editor,setEditor] = useState(''), [recipient,setRecipient] = useState(''), [key,setKey] = useState('description'), [value,setValue] = useState('');
  const [child,setChild] = useState(''), [childOwner,setChildOwner] = useState(''), [days,setDays] = useState(30), [replace,setReplace] = useState(false), [transferConfirmed,setTransferConfirmed] = useState(false), [revokeConfirmed,setRevokeConfirmed] = useState(false);
  const [resolver,setResolverInfo] = useState<Awaited<ReturnType<typeof ctx.reader.inspectResolver>>>();
  const [resolverError,setResolverError] = useState(''), [acceptUnverified,setAcceptUnverified] = useState(false), [needsReset,setNeedsReset] = useState(false);
  const resetsResolver = ctx.reader.deployment.protocolVersion === 7;
  const name=h.label.label;
  useEffect(() => {
    let live = true; setResolverInfo(undefined); setResolverError(''); setAcceptUnverified(false);
    if (!resetsResolver) void ctx.reader.inspectResolver(h.node,h.record.generation,h.snapshot)
      .then(info => { if (live) setResolverInfo(info); }).catch(error => { if (live) setResolverError(errorMessage(error)); });
    return () => { live = false; };
  }, [ctx,h,resetsResolver]);
  const [children,setChildren] = useState<Awaited<ReturnType<typeof listSubnames>>>();
  const [childError,setChildError] = useState("");
  const [childBusy,setChildBusy] = useState(false);
  const [showChildren,setShowChildren] = useState(false);
  const childEpoch = useRef(0), childLoading = useRef<number>();
  const selectChild = (label: string) => {
    setChild(label);
    setReplace(false);
    setRevokeConfirmed(false);
  };
  const loadChildren = async (cursor?: NonNullable<typeof children>["cursor"], epoch = childEpoch.current) => {
    if (childLoading.current === epoch) return;
    childLoading.current = epoch;
    setChildBusy(true);
    setChildError("");
    try {
      const result = await listSubnames(ctx.reader, h.node, { cursor });
      if (epoch !== childEpoch.current) return;
      setChildren(old => ({ ...result, names: [...new Map([...(cursor ? old?.names ?? [] : []), ...result.names].map(n => [n.node, n])).values()] }));
    } catch (error) {
      if (epoch === childEpoch.current) setChildError(errorMessage(error));
    } finally {
      if (childLoading.current === epoch) childLoading.current = undefined;
      if (epoch === childEpoch.current) setChildBusy(false);
    }
  };
  useEffect(() => {
    const epoch = ++childEpoch.current;
    setChildren(undefined); setChildError(""); setChildBusy(false);
    if (showChildren) void loadChildren(undefined, epoch);
    return () => { childEpoch.current++; };
  }, [ctx, h, showChildren]);
  useEffect(() => { let live=true; setError(''); setOffer(undefined); setRecords({}); setCurrentManager('');
    Promise.all([ctx.reader.getTextRecords(h.node,h.record.generation,h.snapshot),ctx.reader.getManager(h.node,h.record.generation,h.snapshot),ctx.reader.getTransfer(h.node,h.record.generation,h.snapshot)]).then(([r,m,o])=>{if(live){setRecords(r);setCurrentManager(m.isZero()?'':m.toString());setOffer(o);}}).catch(e=>{if(live)setError(errorMessage(e));});return()=>{live=false;};
  },[ctx,h]);
  const act=(label:string,run:(opts:TxOptions)=>Promise<unknown>)=>void tx.exec(label,async onUpdate=>{await run({onUpdate});onDone();});
  const active=h.status==='active', incoming=offer?.recipient.equals(ctx.account)&&offer.expiresAt>h.snapshot.timestamp;
  return <>
    {error && <Card tone="err">{t(error)}</Card>}
    {incoming && active && <Card title={t('Incoming transfer')}>
      <p>{t('Accepting clears previous records, editor access and primary confirmation. Existing subnames become inactive.')}</p>
      {resetsResolver ? <p>{t('Accepting resets the resolver to the default')}</p> : <>
        <p>{t('This registry inherits the current resolver on acceptance.')}</p>
        {resolver && <><CopyValue value={resolver.address.toString()}/><p>{t(resolver.verified ? 'Resolver verified' : 'Unverified resolver: address records may be controlled by a third party')}</p></>}
        {resolverError && <p className="err">{t(resolverError)}</p>}
        {resolver && !resolver.verified && <label className="check-field"><input type="checkbox" checked={acceptUnverified} onChange={e=>setAcceptUnverified(e.target.checked)}/>{t('I accept the inherited unverified resolver and will reset it after acceptance.')}</label>}
      </>}
      <p>{t('Offer expires')}: {date(offer!.expiresAt)}</p>
      <button disabled={tx.busy || (!resetsResolver && (!resolver || (!resolver.verified && !acceptUnverified)))} onClick={()=>act('Accept transfer',async opts=>{
        const result=await acceptTransfer(ctx,{name,acceptUnverifiedResolver:acceptUnverified},opts);
        setNeedsReset(!result.resolverReset && (!result.resolver?.verified || !result.resolver?.isDefault));
      })}>{t('Accept transfer')}</button>
    </Card>}
    {needsReset && h.isHolder && active && <Card><p>{t('Use the default resolver before setting address records.')}</p><button disabled={tx.busy} onClick={()=>act('Switch resolver',async opts=>{
      const modules=await ctx.reader.getModules(); await setResolver(ctx,{name,resolver:modules.resolver},opts); setNeedsReset(false);
    })}>{t('Use default resolver')}</button></Card>}

    {h.canEdit && active && <Card title={t('Profile and address records')}>
      <p className="muted">{t('Public records. Up to 64 distinct keys per registration; 248 UTF-8 bytes per value.')}</p>
      <div className="record-list">{Object.entries(records).map(([k,v])=><div key={k}><button className="ghost" onClick={()=>{setKey(k);setValue(v);}}>{k}</button><span>{v}</span></div>)}</div>
      <Field label={t('Record key')} hint={t('Use description, url, avatar, or address:eip155:1 for Ethereum.')}><input list="profile-keys" value={key} onChange={e=>setKey(e.target.value)} maxLength={31}/><datalist id="profile-keys">{['description','url','avatar','com.github','com.twitter','address:eip155:1','address:eip155:8453'].map(k=><option key={k} value={k}/>)}</datalist></Field>
      <Field label={t('Record value')} hint={t('Leave empty to remove this record.')}><textarea value={value} onChange={e=>setValue(e.target.value)} rows={3}/></Field>
      <button disabled={tx.busy||!key} onClick={()=>act('Save record',opts=>setTextRecord(ctx,{name,key,value},opts))}>{t('Save record')}</button>
    </Card>}
    {h.isHolder && active && <>
      <details><summary>{t('Editor permissions')}</summary><Card><p>{t('An editor can change address and profile records. Ownership, transfers, subnames and renewals stay with the owner.')}</p>{manager ? <CopyValue value={manager}/> : <p>{t('No editor assigned')}</p>}<Field label={t('Editor address')}><input value={editor} onChange={e=>setEditor(e.target.value)} placeholder="0x…"/></Field><div className="row"><button disabled={tx.busy||!editor} onClick={()=>act('Assign editor',opts=>setManager(ctx,{name,manager:address(editor)},opts))}>{t('Assign editor')}</button><button className="ghost" disabled={tx.busy||!manager} onClick={()=>act('Remove editor',opts=>setManager(ctx,{name,manager:AztecAddress.ZERO},opts))}>{t('Remove editor')}</button></div></Card></details>
      <details onToggle={e=>setShowChildren(e.currentTarget.open)}><summary>{t('Subnames')}</summary><Card>{childBusy&&<p>{t("Loading subnames…")}</p>}{childError&&<p role="alert">{t(childError)}</p>}{children?.names.map(c=><div className="name-row" key={c.name}><a href={`#/name/${c.name}`}>{formatName(c.name)}</a><span>{t(c.status === 'active' ? 'Active' : 'Inactive subname')}</span><button className="ghost" onClick={()=>selectChild(c.name.split(".")[0])}>{t("Select")}</button></div>)}{children&&!children.complete&&<button disabled={childBusy} onClick={()=>void loadChildren(children.cursor)}>{t("Load more")}</button>}<p>{t('Create a name such as team.alice.fog. Parent owners can revoke or reissue subnames. Their lease cannot exceed the parent lease.')}</p><Field label={t('Subname label')}><input value={child} onChange={e=>selectChild(e.target.value)} placeholder="team"/></Field><Field label={t('Subname owner')}><input value={childOwner} onChange={e=>setChildOwner(e.target.value)} placeholder={ctx.account.toString()}/></Field><Field label={t('Lease in days')}><input type="number" min={1} max={1825} value={days} onChange={e=>setDays(Number(e.target.value))}/></Field><label className="check-field"><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>{t('Allow replacing an existing subname and clearing its records.')}</label><button disabled={tx.busy||!child||!Number.isInteger(days)||days<1} onClick={()=>act('Issue subname',async opts=>{const full=`${child}.${name}`;const existing=await getName(ctx.reader,full);if(existing.record.generation&&!replace)throw new AnsError('invalid_argument','This subname exists. Confirm replacement first.');const now=(await ctx.reader.snapshot()).timestamp;await issueSubname(ctx,{parent:name,label:child,owner:childOwner?address(childOwner):ctx.account,expiresAt:now+BigInt(days)*86400n,replaceExisting:replace},opts);})}>{t('Issue subname')}</button><label className="check-field"><input type="checkbox" checked={revokeConfirmed} onChange={e=>setRevokeConfirmed(e.target.checked)}/>{t('Revoke this subname and invalidate its descendants.')}</label><button className="ghost" disabled={tx.busy||!child||!revokeConfirmed} onClick={()=>act('Revoke subname',opts=>revokeSubname(ctx,{name:`${child}.${name}`},opts))}>{t('Revoke subname')}</button></Card></details>
      <details><summary>{t('Transfer ownership')}</summary><Card><p>{t('The recipient must accept within seven days. Acceptance clears records and editor access, and invalidates subnames.')}</p>{offer&&!offer.recipient.isZero()&&<><CopyValue value={offer.recipient.toString()}/><p>{t('Offer expires')}: {date(offer.expiresAt)}</p><button className="ghost" disabled={tx.busy} onClick={()=>act('Cancel transfer',opts=>offerTransfer(ctx,{name,recipient:AztecAddress.ZERO},opts))}>{t('Cancel transfer')}</button></>}<Field label={t('Recipient address')}><input value={recipient} onChange={e=>{setRecipient(e.target.value);setTransferConfirmed(false);}} placeholder="0x…"/></Field><label className="check-field"><input type="checkbox" checked={transferConfirmed} onChange={e=>setTransferConfirmed(e.target.checked)}/>{t('I have checked the recipient and understand that ownership will change after acceptance.')}</label><button disabled={tx.busy||!recipient||!transferConfirmed} onClick={()=>act('Offer transfer',opts=>offerTransfer(ctx,{name,recipient:address(recipient)},opts))}>{t('Offer transfer')}</button></Card></details>
    </>}
    <TxLine tx={tx}/>
  </>;
}
