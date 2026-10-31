import { Component, type ReactNode } from 'react';
import { translate } from './i18n';

/** Keep the wallet and navigation mounted if a deferred page cannot load after a release. */
export class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card" role="alert">
        <h2>{translate('Page could not be loaded')}</h2>
        <p>{translate('Reload the page and reconnect your wallet to continue from saved progress.')}</p>
        <p>{translate('If your wallet is still processing a transaction, check its result before reloading.')}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {translate('Reload page')}
        </button>
      </section>
    );
  }
}
