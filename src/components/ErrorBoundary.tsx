import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { tx, type UiLang } from '../i18n';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  lang?: UiLang;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled React Error caught by ErrorBoundary:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  public render() {
    const lang: UiLang = this.props.lang || 'en';
    if (this.state.hasError) {
      return (
        <div className="p-8 max-w-3xl mx-auto my-12 rounded-xl bg-[#121215] border border-red-500/30 text-zinc-100 shadow-2xl space-y-4">
          <div className="flex items-center space-x-3 text-red-400">
            <AlertTriangle className="w-6 h-6 shrink-0" />
            <h2 className="text-base font-bold">
              {this.props.fallbackTitle ||
                tx(lang, 'Component Rendering Error Recovered', 'กู้คืนข้อผิดพลาดการแสดงผลสำเร็จ')}
            </h2>
          </div>

          <p className="text-xs text-zinc-400 leading-relaxed">
            {tx(
              lang,
              'The page encountered an unexpected rendering exception. Rather than showing a blank screen, the application captured the state details below.',
              'หน้าจอพบข้อผิดพลาดที่ไม่คาดคิดในการแสดงผล ระบบจึงบันทึกรายละเอียดไว้ด้านล่างแทนการแสดงหน้าจอว่าง'
            )}
          </p>

          {this.state.error && (
            <div className="p-3.5 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs text-red-300 overflow-x-auto">
              <span className="font-bold text-red-400 block mb-1">
                {tx(lang, 'Error:', 'ข้อผิดพลาด:')}
              </span>
              {this.state.error.toString()}
            </div>
          )}

          {this.state.errorInfo?.componentStack && (
            <details className="text-[11px] font-mono text-zinc-500">
              <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">
                {tx(lang, 'View Component Stack Trace', 'ดูรายละเอียด Component Stack Trace')}
              </summary>
              <pre className="mt-2 p-3 rounded bg-zinc-950/90 overflow-x-auto text-zinc-400">
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}

          <div className="pt-2 flex items-center space-x-3">
            <button
              onClick={this.handleReset}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-600/20 transition-all flex items-center space-x-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{tx(lang, 'Reload Application View', 'โหลดหน้าจอโปรแกรมใหม่')}</span>
            </button>

            <button
              onClick={() => {
                this.setState({ hasError: false, error: null, errorInfo: null });
              }}
              className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition-all"
            >
              {tx(lang, 'Attempt Soft Recovery', 'ลองกู้คืนหน้าจอชั่วคราว')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
