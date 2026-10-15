/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/** Contains rendering failures to one page instead of blanking the app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ marginTop: 80 }}>
        <TriangleAlert strokeWidth={1.5} />
        <div className="empty__title">This view hit a problem</div>
        <div className="selectable" style={{ maxWidth: 480 }}>{this.state.error.message}</div>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
