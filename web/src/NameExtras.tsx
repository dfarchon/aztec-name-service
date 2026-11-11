import { useEffect, useState } from 'react';
import { formatName, type RegistryReader, type Snapshot } from '@ans/sdk/read';
import { Card, CopyValue } from './components';
import { translate as t } from './i18n';
import { favoriteKey, readFavorites, toggleFavorite } from './portfolio';
import { errorMessage } from './format';

export function FavoriteButton({ reader, name }: { reader: RegistryReader; name: string }) {
  const key = favoriteKey(reader.deployment.chainId, reader.registry.toString());
  const [saved, setSaved] = useState(() => readFavorites(key).includes(name)), [error, setError] = useState('');
  useEffect(() => { const on = () => setSaved(readFavorites(key).includes(name)); on(); window.addEventListener('ans:favorites', on); window.addEventListener('storage', on); return () => { window.removeEventListener('ans:favorites', on); window.removeEventListener('storage', on); }; }, [key, name]);
  return <><button className="ghost" aria-pressed={saved} onClick={() => { try { toggleFavorite(key, name); setError(''); } catch { setError('Favorites could not be saved in this browser.'); } }}>{t(saved ? 'Remove favorite' : 'Save favorite')}</button>{error && <small role="alert">{t(error)}</small>}</>;
}
export function ShareName({ name }: { name: string }) {
  const [qr, setQr] = useState(''), [error, setError] = useState(''), [open, setOpen] = useState(false);
  const url = `${location.origin}${location.pathname}#/name/${encodeURIComponent(name)}`;
  useEffect(() => { let live = true; setQr(''); setError(''); if (open) import('qrcode').then(q => q.toDataURL(url, { width: 256, margin: 3, errorCorrectionLevel: 'M' })).then(data => { if (live) setQr(data); }).catch(() => { if (live) setError('QR code unavailable. Copy the link instead.'); }); return () => { live = false; }; }, [url, open]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>{t('Share name')}</summary><div className="share-card"><h3>{formatName(name)}</h3>{qr && <img width="256" height="256" src={qr} alt={t('QR code for this name')} />}<CopyValue value={url} label={t('Copy profile link')} /><small>{t('This link shares the public profile. It is not a payment request.')}</small>{error && <p role="alert">{t(error)}</p>}</div></details>;
}
export function PublicRecords({ reader, node, generation, snapshot }: { reader: RegistryReader; node: bigint; generation: number; snapshot: Snapshot }) {
  const [records, setRecords] = useState<Record<string, string>>(), [error, setError] = useState('');
  useEffect(() => { let live = true; setRecords(undefined); setError(''); reader.getTextRecords(node, generation, snapshot).then(r => { if (live) setRecords(r); }).catch(e => { if (live) setError(errorMessage(e)); }); return () => { live = false; }; }, [reader, node, generation, snapshot]);
  if (!reader.extended) return null;
  return <Card title={t('Public profile')}>{error ? <p role="alert" className="err">{t(error)}</p> : !records ? <p>{t('Loading records…')}</p> : Object.keys(records).length ? <dl className="profile-records">{Object.entries(records).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{key === 'url' && /^https?:\/\//i.test(value) ? <a href={value} target="_blank" rel="noopener noreferrer">{value}</a> : <CopyValue value={value} label={t('Copy record')} />}</dd></div>)}</dl> : <p className="muted">{t('No public records yet.')}</p>}</Card>;
}
export function SetupChecklist({ registered, address, primary }: { registered: boolean; address: boolean; primary: boolean }) {
  return <ol className="setup-checklist" aria-label={t('Name setup')}>{[[registered,'Registered'],[address,'Address configured'],[primary,'Primary name set']].map(([done,label]) => <li key={String(label)} data-complete={String(done)}><span aria-label={t(done ? 'Complete' : 'Incomplete')}>{done ? '✓' : '○'}</span> {t(String(label))}</li>)}</ol>;
}
