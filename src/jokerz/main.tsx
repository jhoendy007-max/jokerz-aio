import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

class RootBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: unknown) {
    console.error('[RootBoundary]', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#fff', background: '#070b14', minHeight: '100vh' }}>
          <h1 style={{ color: '#f87171', fontSize: 20 }}>UI crashed</h1>
          <pre style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            style={{
              marginTop: 16,
              padding: '8px 16px',
              background: '#7c3aed',
              border: 0,
              borderRadius: 8,
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
            onClick={() => {
              try {
                localStorage.removeItem('jokerz_settings_tab');
                localStorage.setItem('jokerz_active_tab', 'tasks');
              } catch {
                /* */
              }
              window.location.reload();
            }}
          >
            Reload → Tasks
          </button>
          <button
            type="button"
            style={{
              marginTop: 16,
              marginLeft: 8,
              padding: '8px 16px',
              background: '#334155',
              border: 0,
              borderRadius: 8,
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
            onClick={() => {
              try {
                localStorage.clear();
              } catch {
                /* */
              }
              window.location.reload();
            }}
          >
            Clear localStorage + Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  document.body.innerHTML = '<pre style="color:red;padding:24px">#root missing</pre>';
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <RootBoundary>
        <App />
      </RootBoundary>
    </StrictMode>
  );
}
