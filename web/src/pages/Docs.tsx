import { useEffect, useRef, useState } from 'react';
import type { RegistryReader, RegistryConfig } from '@ans/sdk/read';
import { articles, articleToMarkdown, groups, sectionsFor, summaries, type Article, type DocBlock } from '../docs-content';
import { Card, CopyValue } from '../components';
import { FeeAmount } from '../fees';
import { translate as t } from '../i18n';
import { useSession } from '../session';
import { SdkDownloads } from '../SdkDownloads';
import { deploymentProtocolLabel } from '../deployment';
import { config } from '../config';

const searchIndex = new Map(articles.map(article=>[article.id, articleToMarkdown(article).toLowerCase()]));

function CopyText({ value, markdown = false }: { value: string; markdown?: boolean }) {
 const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
 useEffect(() => { setState('idle'); }, [value]);
 return <button type="button" className="ghost doc-copy" onClick={async () => {
  try { await navigator.clipboard.writeText(value); setState('copied'); }
  catch { setState('failed'); }
 }} aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed · retry' : markdown ? 'Copy Markdown' : 'Copy code'}</button>;
}

function ActiveFees() {
 const { reader } = useSession();
 const [revision, refresh] = useState(0);
 const [read, setRead] = useState<{ reader: RegistryReader; config: RegistryConfig; block: number; timestamp: bigint }>();
 const [failed, setFailed] = useState(false);
 useEffect(() => {
  let live = true; setFailed(false);
  if (reader) void (async () => {
   const snapshot = await reader.snapshot('finalized');
   const config = await reader.getConfig(snapshot);
   if (!await reader.isCanonical(snapshot)) throw new Error('Non-canonical fee snapshot');
   if (live) setRead({ reader, config, block: snapshot.blockNumber, timestamp: snapshot.timestamp });
  })().catch(() => { if (live) { setRead(undefined); setFailed(true); } });
  return () => { live = false; };
 }, [reader, revision]);
 const current = read?.reader === reader ? read : undefined;
 return <div className="doc-fees" aria-live="polite">
  {current ? <>
   <p className="doc-price"><FeeAmount amount={current.config.annualPrice} token={current.config.feeToken.toString()} /> <span>/ year</span></p>
   <dl><dt>Payment token</dt><dd><CopyValue value={current.config.feeToken.toString()} /></dd><dt>Registrar</dt><dd><CopyValue value={current.config.registrar?.toString() ?? current.reader.registry.toString()} /></dd><dt>Price version / block</dt><dd>{current.config.priceVersion} / {current.block}</dd></dl>
  </> : <p>{failed ? 'The live quote could not be verified. Open Register and retry before paying.' : 'Reading the active Registrar…'}</p>}
  <div className="doc-inline-actions"><button type="button" className="ghost" onClick={() => { setRead(undefined); refresh(n=>n+1); }}>Refresh fees</button><a href="#/register">Open Register →</a></div>
 </div>;
}

function DeploymentInfo() {
 const { reader } = useSession();
 return reader ? <dl className="doc-deployment"><dt>Registry</dt><dd><CopyValue value={reader.registry.toString()} /></dd><dt>Contract class</dt><dd><CopyValue value={reader.classId} /></dd><dt>Protocol features</dt><dd>{deploymentProtocolLabel(reader)}</dd><dt>RPC</dt><dd>{config.nodeUrl}</dd></dl> : <p>Connect to the node to verify this deployment.</p>;
}

function Block({ block }: { block: DocBlock }) {
 switch (block.type) {
  case 'paragraph': return <p>{block.text}</p>;
  case 'steps': return <ol className="doc-steps">{block.items.map((item,i)=><li key={i}><span className="doc-step-number" aria-hidden="true">{i+1}</span><p>{item}</p></li>)}</ol>;
  case 'list': return <ul className="doc-list">{block.items.map((item,i)=><li key={i}>{item}</li>)}</ul>;
  case 'table': return <div className="doc-table-wrap"><table><thead><tr>{block.headers.map((h,i)=><th scope="col" key={i}>{h}</th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
  case 'callout': return <aside className="doc-callout"><strong>{block.title}</strong><p>{block.text}</p></aside>;
  case 'code': return <figure className="doc-code"><figcaption><span>{block.title}</span><CopyText value={block.value} /></figcaption><pre><code>{block.value}</code></pre><span className="doc-code-language">{block.language}</span></figure>;
  case 'links': return <ul className="doc-links">{block.items.map(link=><li key={link.href}><a href={link.href} {...(link.href.startsWith('https:') ? {target:'_blank',rel:'noopener noreferrer'} : {})}>{link.title} <span aria-hidden="true">↗</span></a></li>)}</ul>;
  case 'downloads': return <SdkDownloads />;
  case 'deployment': return <DeploymentInfo />;
  case 'fees': return <ActiveFees />;
 }
}

function ArticleView({ article }: { article: Article }) {
 const sections = sectionsFor(article), position = articles.indexOf(article);
 const markdown = articleToMarkdown(article);
 const [active, setActive] = useState(sections[0].id);
 useEffect(() => {
  setActive(sections[0].id);
  const observer = new IntersectionObserver(entries => {
   const visible = entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);
   if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: '-5% 0px -60% 0px' });
  for (const section of sections) { const element = document.getElementById(section.id); if (element) observer.observe(element); }
  return () => observer.disconnect();
 }, [article.id]);
 const jump = (id: string) => { setActive(id); const element=document.getElementById(id); element?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}); element?.focus({preventScroll:true}); };
 const toc = <><strong>On this page</strong><nav aria-label="Article sections">{sections.map(section=><button type="button" key={section.id} className={active===section.id?'active':''} aria-current={active===section.id?'location':undefined} onClick={()=>jump(section.id)}>{section.title}</button>)}</nav></>;
 return <>
  <article className="doc-article">
   <header className="doc-article-header"><div className="doc-breadcrumb"><a href="#/docs">Documentation</a><span>/</span><span>{groups.find(group=>group.id===article.group)!.title}</span></div><h1>{article.title}</h1><p className="doc-lead">{summaries[article.id]}</p><div className="doc-article-tools"><CopyText value={markdown} markdown /><a href={`/downloads/docs/en/${article.id}.md`} download>Download .md</a><button type="button" className="ghost" onClick={()=>window.print()}>Print / save PDF</button></div></header>
   <details className="doc-mobile-toc"><summary>On this page</summary>{toc}</details>
   {sections.map(section=><section className="doc-section" id={section.id} key={section.id} tabIndex={-1}><h2>{section.title}</h2>{section.blocks.map((block,i)=><Block key={i} block={block} />)}</section>)}
   <div className="doc-article-footer"><p>Need to check the connected network? <a href="#/status">{t('View service status')} →</a></p><nav className="doc-pagination" aria-label="Adjacent articles">{[articles[position-1],articles[position+1]].map((item,i)=>item ? <a key={item.id} href={`#/docs/${item.id}`}><small>{i===0?'Previous':'Next'}</small><strong>{item.title} {i===1?'→':''}</strong></a> : <span key={i} />)}</nav></div>
  </article>
  <aside className="doc-toc">{toc}</aside>
 </>;
}

export function DocsPage({ article, help=false }: { article?: string; help?: boolean }) {
 const mobileNavigation=useRef<HTMLDetailsElement>(null);
 const [query,setQuery] = useState('');
 const selected = articles.find(a=>a.id===article), needle=query.trim().toLowerCase();
 const visible = articles.filter(a=>(!help || a.group==='help') && searchIndex.get(a.id)!.includes(needle));
 useEffect(() => { setQuery(''); if(mobileNavigation.current) mobileNavigation.current.open=false; window.scrollTo(0,0); }, [article,help]);
 const navigation = <><a className="doc-home-link" href="#/docs">ANS documentation</a><label className="doc-search"><span>{t('Search documentation')}</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search articles…" /></label><nav className="doc-sidebar-nav" aria-label={t('Documentation navigation')}>{groups.map(group=>{
  const entries=visible.filter(a=>a.group===group.id);
  return entries.length ? <div className="doc-nav-group" key={group.id}><h2>{group.title}</h2>{entries.map(a=><a href={`#/docs/${a.id}`} aria-current={selected?.id===a.id?'page':undefined} className={selected?.id===a.id?'active':''} key={a.id}>{a.title}</a>)}</div> : null;
 })}</nav>{!visible.length && <p className="muted" role="status">{t('No matching articles.')}</p>}<a className="doc-sidebar-status" href="#/status">{t('View service status')} ↗</a></>;
 return <div className={`documentation ${selected?'has-article':''}`}>
  <aside className="doc-sidebar">{navigation}</aside><details className="doc-mobile-navigation" ref={mobileNavigation}><summary>Browse documentation</summary>{navigation}</details>
  {selected ? <ArticleView key={selected.id} article={selected} /> : <div className="doc-index">
   <header className="doc-index-header"><span className="doc-kicker">{help?'Help and recovery': 'AZTEC NAME SERVICE'}</span><h1>{article?'Article not found':help?'Get back on track.':'Your name. Your next step.'}</h1><p className="doc-lead">{article?'Choose a guide below or search the documentation.':help?'Find the right receipt, wallet or recovery step.':'Guides for your first name and everything you build with it.'}</p></header>
   {!help && !needle && <div className="doc-entry-grid">{['getting-started','sdk','pricing'].map((id,i)=><a className="doc-entry" href={`#/docs/${id}`} key={id}><span className="doc-entry-number">0{i+1}</span><strong>{articles.find(a=>a.id===id)!.title}</strong><span>{summaries[id]}</span><span className="doc-entry-arrow" aria-hidden="true">↗</span></a>)}</div>}
   {groups.map(group=>{const entries=visible.filter(a=>a.group===group.id);return entries.length ? <section className="doc-category" key={group.id}><header><h2>{group.title}</h2><p>{group.description}</p></header><div className="doc-category-links">{entries.map(a=><a href={`#/docs/${a.id}`} key={a.id}><span><strong>{a.title}</strong><small>{summaries[a.id]}</small></span><span aria-hidden="true">→</span></a>)}</div></section> : null;})}
   {!visible.length && <p role="status">{t('No matching articles.')}</p>}
   <p className="doc-reference">{t('Reference:')} <a href="https://docs.ens.domains/" target="_blank" rel="noopener noreferrer">ENS</a> · <a href="https://docs.aztec.network/" target="_blank" rel="noopener noreferrer">Aztec</a></p>
  </div>}
 </div>;
}

export function ChangelogPage() {
 const releases=[
  {version:'SDK 0.6.0',title:'Prices by name length',text:'Like ENS, shorter names cost more: 128, 32 and 1 per year for 3, 4 and 5+ characters, and renewals use the same tier. New names cannot contain "--" or start with "0x". Existing names keep resolving and renewing. Quotes now take the name.'},
  {version:'V5 / SDK 0.5.0',title:'Direct administrator configuration',text:'Immediate module configuration, receipt-safe payment recovery and holder-initiated migration for new core deployments.'},
  {version:'SDK 0.4.5',title:'Faster first load and payment readiness',text:'Contract execution code loads when needed. Registration and renewal check the exact private payment balance before confirmation. Registration plans recover existing receipts after reload.'},
  {version:'October 2026',title:'Documentation and developer onboarding',text:'A structured documentation center, downloadable SDK starter, exact token metadata, private payment balance checks and recoverable registration plans. AZTEC is the selected pricing currency; the pricing page reads the active payment asset from the chain.'},
  {version:'V4',title:'Names as a complete profile',text:'Recipient-confirmed transfers, editor permissions, subnames, public profiles and multi-chain address records. Favorites, expiry calendars and profile QR codes make names easier to manage and share.'},
  {version:'V2',title:'Public name registration',text:'Paid registration and renewal, Aztec address records and bidirectionally verified primary names.'},
 ];
 return <Card title={t('Product updates')}><p className="muted">{t('Public deployment is tracked separately on the Status page.')}</p><ol className="doc-changelog">{releases.map(release=><li key={release.version}><span>{release.version}</span><h3>{release.title}</h3><p>{release.text}</p></li>)}</ol><a href="#/docs">Explore the documentation →</a></Card>;
}
