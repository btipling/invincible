'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ember, teal, warm } from '../lib/palette';
import {
  DEFAULT_MODEL_LABEL,
  sendChat,
  validatePrompt,
} from '../lib/chatApi';
import AppNav from './components/AppNav';

type Status = 'idle' | 'loading' | 'success' | 'error';

export default function PromptPlayground() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const busy = status === 'loading';

  const onSubmit = useCallback(async () => {
    const validation = validatePrompt(prompt);
    if (validation) {
      setError(validation);
      setStatus('error');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setResponse('');
    setStatus('loading');

    const result = await sendChat(prompt, { signal: controller.signal });
    if (controller.signal.aborted) return;

    if (result.ok) {
      setResponse(result.text);
      setStatus('success');
    } else {
      setError(result.error);
      setStatus('error');
    }
  }, [prompt]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!busy) void onSubmit();
      }
    },
    [busy, onSubmit],
  );

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: teal.bg,
        color: teal.text,
        boxSizing: 'border-box',
      }}
    >
      <AppNav
        right={
          <span
            style={{
              fontSize: '0.75rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: warm.muted,
              border: `1px solid ${warm.border}`,
              background: warm.surface,
              borderRadius: 4,
              padding: '0.2rem 0.5rem',
            }}
            title="Server selects the real model in Phase 1.4"
          >
            {DEFAULT_MODEL_LABEL}
          </span>
        }
      />

      <div
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 800,
          margin: '0 auto',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          boxSizing: 'border-box',
        }}
      >
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
            border: `1px solid ${teal.border}`,
            background: teal.surface,
            borderRadius: 8,
            padding: '1rem',
          }}
        >
          <label
            htmlFor="prompt"
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: teal.muted,
            }}
          >
            Prompt
          </label>
          <textarea
            id="prompt"
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            rows={8}
            placeholder="Send a prompt… (⌘/Ctrl + Enter)"
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 140,
              boxSizing: 'border-box',
              border: `1px solid ${teal.border}`,
              borderRadius: 6,
              background: teal.bg,
              color: teal.text,
              padding: '0.75rem 0.85rem',
              fontSize: '0.95rem',
              lineHeight: 1.5,
              fontFamily: 'inherit',
              outline: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = teal.accent;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = teal.border;
            }}
          />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.75rem',
            }}
          >
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={busy}
              style={{
                appearance: 'none',
                border: 'none',
                borderRadius: 6,
                padding: '0.55rem 1.1rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                background: busy ? teal.border : teal.accent,
                color: teal.bg,
                opacity: busy ? 0.7 : 1,
              }}
              onMouseEnter={(e) => {
                if (!busy) e.currentTarget.style.background = teal.accentDark;
              }}
              onMouseLeave={(e) => {
                if (!busy) e.currentTarget.style.background = teal.accent;
              }}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
            <span style={{ fontSize: '0.8rem', color: teal.muted }}>
              ⌘/Ctrl + Enter
            </span>
            {prompt.trim().length > 0 && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: '0.75rem',
                  color: teal.muted,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {prompt.trim().length.toLocaleString()} chars
              </span>
            )}
          </div>
        </section>

        {error && (
          <section
            role="alert"
            style={{
              border: `1px solid ${ember.border}`,
              background: ember.surface,
              color: ember.text,
              borderRadius: 8,
              padding: '0.85rem 1rem',
              fontSize: '0.9rem',
            }}
          >
            <strong style={{ color: ember.accent, fontWeight: 600 }}>Error · </strong>
            {error}
          </section>
        )}

        <section
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
            border: `1px solid ${teal.border}`,
            background: teal.surface,
            borderRadius: 8,
            padding: '1rem',
            minHeight: 180,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '0.75rem',
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: '0.8rem',
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: teal.muted,
              }}
            >
              Response
            </h2>
            {status === 'loading' && (
              <span style={{ fontSize: '0.8rem', color: warm.accent }}>
                waiting for model…
              </span>
            )}
            {status === 'success' && response && (
              <span style={{ fontSize: '0.8rem', color: teal.accent }}>done</span>
            )}
          </div>
          <pre
            style={{
              margin: 0,
              flex: 1,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: '0.9rem',
              lineHeight: 1.55,
              color: response ? teal.text : teal.muted,
            }}
          >
            {busy && !response
              ? '…'
              : response ||
                'Model output appears here after Send. Set AI_GATEWAY_API_KEY on the Vercel project, then redeploy.'}
          </pre>
        </section>
      </div>
    </main>
  );
}
