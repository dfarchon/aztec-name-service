import { Component, type ReactNode } from 'react';
import { translate } from './i18n';

/** Keep the wallet and navigation mounted if a deferred page cannot load after a release. */
export class RouteBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: Readonly<{ children: ReactNode; resetKey?: string }>) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
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
