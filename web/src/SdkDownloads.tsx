import { useEffect, useState } from 'react';
import { CopyValue } from './components';
import { translate as t } from './i18n';

type Download = { url: string; sha256: string };
type Manifest = { sdkVersion: string; sourceRelease: string; sdk: Download; starter: Download };
function validDownload(d: Download) {
  return (
    /^\/downloads\/sdk\/ans-(sdk|consumer)-[a-zA-Z0-9.-]+\.(tgz|zip)$/.test(d?.url) &&
    /^[a-f0-9]{64}$/.test(d?.sha256)
  );
}
export function SdkDownloads() {
  const [manifest, setManifest] = useState<Manifest>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void fetch('/downloads/sdk/manifest.json', { cache: 'no-store', signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('SDK downloads unavailable');
        const value: Manifest = await r.json();
        if (
          !validDownload(value.sdk) ||
          !validDownload(value.starter) ||
          typeof value.sdkVersion !== 'string' ||
          typeof value.sourceRelease !== 'string'
        )
          throw new Error('Invalid download manifest');
        if (live) setManifest(value);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, []);
  return (
    <section className="sdk-downloads" aria-live="polite">
      <h3>{t('SDK downloads')}</h3>
      {manifest ? (
        <>
          <p>
            {t('SDK')} {manifest.sdkVersion} · {t('Version')} {manifest.sourceRelease}
          </p>
          <p>
            <a href={manifest.starter.url} download>
              {t('Download runnable starter')}
            </a>{' '}
            ·{' '}
            <a href={manifest.sdk.url} download>
              {t('Download SDK package')}
            </a>
          </p>
          <p className="muted">
            {t(
              'The starter includes the SDK package, testnet configuration and integration instructions in English and Chinese.',
            )}
          </p>
          <details>
            <summary>{t('Verify downloads')}</summary>
            <dl>
              <dt>{t('Starter SHA-256')}</dt>
              <dd>
                <CopyValue value={manifest.starter.sha256} />
              </dd>
              <dt>{t('SDK SHA-256')}</dt>
              <dd>
                <CopyValue value={manifest.sdk.sha256} />
              </dd>
            </dl>
            <a href="/downloads/sdk/manifest.json">{t('Deployment and package manifest')}</a>
          </details>
          <pre className="code-sample">
            <code>{`unzip ${manifest.starter.url.split('/').pop()}\ncd ans-consumer\nnpm install\nnpm run check\nnpm run doctor\nnpm run read\nnpm run dev`}</code>
          </pre>
        </>
      ) : (
        <p className="muted">
          {t(failed ? 'SDK downloads are unavailable on this build.' : 'Loading…')}
        </p>
      )}
    </section>
  );
}
