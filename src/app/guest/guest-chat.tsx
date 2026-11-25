'use client';

import { SparklesIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { Conversation } from '../../chat';
import type { Message } from '../../conversations';
import { api } from '../components/api';

type GuestConversation = { name: string; role: string; title: string; messages?: Message[] };

export function GuestChat() {
  const [token, setToken] = useState<string | null>();
  const [conversation, setConversation] = useState<GuestConversation | null>(null);
  const [notice, setNotice] = useState('');
  const [joining, setJoining] = useState(false);
  const sending = useRef(false);

  async function refresh() {
    try {
      const result = await api<GuestConversation>('guest/conversation');
      setConversation(result);
    } catch (error) {
      if ((error as { status?: number }).status === 401) setConversation(null);
      setNotice((error as Error).message);
    }
  }

  useEffect(() => {
    const invite = new URLSearchParams(window.location.hash.slice(1)).get('invite');
    setToken(invite);
    if (!invite) void refresh();
  }, []);

  useEffect(() => {
    if (token !== null || !conversation) return;
    const timer = window.setInterval(() => { if (!sending.current) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [token, Boolean(conversation)]);

  return <main className="guest-page" data-view={conversation ? 'chat' : undefined}>
    <header className="shell-topbar flex h-16 items-center gap-4 px-5">
      <span className="shell-brand"><span className="brand-mark"><SparklesIcon aria-hidden="true" /></span> Cowork</span>
    </header>
    {notice && <div id="notice" role="status">{notice}</div>}
    {token === undefined && <p className="p-6" role="status">Loading invitation…</p>}
    {token && <section className="guest-join panel">
      <span className="chat-agent-mark"><SparklesIcon aria-hidden="true" /></span>
      <h1>Join the conversation</h1>
      <p className="mt-1">Your invitation gives you access to this conversation only.</p>
      <form className="stack mt-4" onSubmit={async (event) => {
        event.preventDefault();
        const name = new FormData(event.currentTarget).get('Name');
        setJoining(true);
        setNotice('');
        try {
          setConversation(await api<GuestConversation>('guest/join', { Token: token, Name: name }));
          window.history.replaceState(null, '', '/guest');
          setToken(null);
        } catch (error) { setNotice((error as Error).message); }
        finally { setJoining(false); }
      }}>
        <label>Your name<input name="Name" autoComplete="name" maxLength={80} required /></label>
        <button className="primary" disabled={joining}>Join conversation</button>
      </form>
    </section>}
    {token === null && conversation && <section id="workspace">
      <header className="workspace-header"><div><h1>{conversation.title}</h1><p className="text-sm">Guest access</p></div></header>
      <div id="conversation-root">
        <Conversation guest role={conversation.role} viewer={conversation.name} threadId="" messages={conversation.messages ?? []}
          send={async (transport) => {
            if (sending.current) return;
            sending.current = true;
            setNotice('');
            try { await transport(); }
            catch (error) { setNotice((error as Error).message); }
            finally { await refresh(); sending.current = false; }
          }} />
      </div>
    </section>}
  </main>;
}
