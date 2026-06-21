import React, { useState, useEffect, useRef } from 'react';
import { subscribeToMessages, sendMessage, markAsRead } from '../services/chat.service';
import { getUserProfile } from '../services/auth.service';

/* ─── Tiny helpers ─────────────────────────────────────────────────── */
function formatTime(ts) {
  if (!ts) return '';
  const ms = ts?.toMillis ? ts.toMillis() : ts;
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function groupByDate(messages) {
  const groups = [];
  let lastDate = null;
  messages.forEach((msg) => {
    const ms = msg.createdAt?.toMillis ? msg.createdAt.toMillis() : msg.createdAt;
    const dateStr = ms
      ? new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      : null;
    if (dateStr && dateStr !== lastDate) {
      groups.push({ type: 'divider', label: dateStr });
      lastDate = dateStr;
    }
    groups.push({ type: 'message', ...msg });
  });
  return groups;
}

/* ─── Bubble ────────────────────────────────────────────────────────── */
function Bubble({ msg, isMine, showAvatar, otherUser }) {
  const time = formatTime(msg.createdAt);
  return (
    <div
      className={`flex items-end gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
      style={{ marginBottom: '2px' }}
    >
      {/* Avatar slot — keeps layout stable */}
      <div className="w-7 h-7 flex-shrink-0">
        {!isMine && showAvatar && (
          <img
            src={otherUser?.photoURL || '/placeholder-avatar.png'}
            alt=""
            className="w-7 h-7 rounded-full object-cover border border-slate-700"
          />
        )}
      </div>

      <div className={`flex flex-col gap-0.5 max-w-[72%] ${isMine ? 'items-end' : 'items-start'}`}>
        <div
          className={`
            px-4 py-2.5 text-sm leading-relaxed
            ${isMine
              ? 'bg-amber-400 text-black rounded-2xl rounded-br-sm font-medium'
              : 'bg-slate-800 text-slate-100 rounded-2xl rounded-bl-sm border border-slate-700/60'}
          `}
          style={{ wordBreak: 'break-word' }}
        >
          {msg.text}
        </div>
        <span className="text-[10px] text-slate-600 px-1">{time}</span>
      </div>
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────────── */
const ChatSystem = ({ activeChatId, currentUser, onBack }) => {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [otherUser, setOtherUser] = useState(null);
  const [sending, setSending] = useState(false);
  const [online] = useState(true); // placeholder — wire to presence if needed
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  /* Other user profile */
  useEffect(() => {
    const otherUid = activeChatId.split('_').find((id) => id !== currentUser.uid);
    getUserProfile(otherUid).then(setOtherUser);
  }, [activeChatId, currentUser.uid]);

  /* Real-time messages */
  useEffect(() => {
    const unsub = subscribeToMessages(activeChatId, (msgs) => {
      setMessages(msgs);
      markAsRead(activeChatId, currentUser.uid);
    });
    return () => unsub();
  }, [activeChatId, currentUser.uid]);

  /* Auto-scroll */
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* Send */
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    setInputText('');
    setSending(true);
    try {
      await sendMessage(activeChatId, currentUser.uid, text);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const grouped = groupByDate(messages);

  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: 'linear-gradient(180deg, #0a0f1e 0%, #050810 100%)',
        fontFamily: "'DM Sans', ui-sans-serif, sans-serif",
      }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/80 flex-shrink-0"
        style={{ background: 'rgba(10,15,30,0.92)', backdropFilter: 'blur(12px)' }}
      >
        <button
          onClick={onBack}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors text-slate-300 text-lg"
          aria-label="Back"
        >
          ←
        </button>

        <div className="relative flex-shrink-0">
          <img
            src={otherUser?.photoURL || '/placeholder-avatar.png'}
            alt={otherUser?.name || ''}
            className="w-9 h-9 rounded-full object-cover border-2 border-slate-700"
          />
          {online && (
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 rounded-full border-2 border-slate-900" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-white truncate leading-tight">
            {otherUser?.name || <span className="text-slate-500">Loading…</span>}
          </p>
          {otherUser?.isInfluencer && (
            <span className="inline-flex items-center text-[9px] uppercase tracking-widest bg-amber-400 text-black px-1.5 py-px rounded-full font-bold leading-none">
              Gold
            </span>
          )}
        </div>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1" style={{ scrollbarWidth: 'none' }}>
        {grouped.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <div className="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center text-2xl">
              👋
            </div>
            <p className="text-slate-400 text-sm">
              Say hi to{' '}
              <span className="text-white font-semibold">{otherUser?.name || 'them'}</span>
            </p>
          </div>
        )}

        {grouped.map((item, i) => {
          if (item.type === 'divider') {
            return (
              <div key={`div-${i}`} className="flex items-center gap-3 py-3">
                <div className="flex-1 h-px bg-slate-800" />
                <span className="text-[10px] text-slate-500 uppercase tracking-wider flex-shrink-0">
                  {item.label}
                </span>
                <div className="flex-1 h-px bg-slate-800" />
              </div>
            );
          }

          const isMine = item.senderId === currentUser.uid;
          const next = grouped[i + 1];
          const showAvatar = !isMine && (next?.type === 'divider' || next?.senderId !== item.senderId || !next);

          return (
            <Bubble
              key={item.id}
              msg={item}
              isMine={isMine}
              showAvatar={showAvatar}
              otherUser={otherUser}
            />
          );
        })}
        <div ref={scrollRef} />
      </div>

      {/* ── Input bar ── */}
      <div
        className="flex items-center gap-2 px-3 py-3 border-t border-slate-800/60 flex-shrink-0"
        style={{ background: 'rgba(10,15,30,0.95)', backdropFilter: 'blur(12px)' }}
      >
        <input
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder="Message…"
          maxLength={500}
          className="flex-1 bg-slate-800/80 border border-slate-700/50 text-white text-sm
                     placeholder-slate-500 rounded-2xl px-4 py-2.5 outline-none
                     focus:border-amber-400/60 transition-colors"
        />
        <button
          onClick={handleSend}
          disabled={!inputText.trim() || sending}
          aria-label="Send"
          className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full
                     bg-amber-400 text-black font-bold text-base
                     disabled:opacity-30 disabled:cursor-not-allowed
                     active:scale-95 transition-all"
        >
          {sending ? (
            <span className="w-4 h-4 border-2 border-black/40 border-t-black rounded-full animate-spin" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.668 5.828H12a.75.75 0 0 1 0 1.5H3.947l-1.668 5.828a.75.75 0 0 0 .826.95 28.9 28.9 0 0 0 15.208-8.293.75.75 0 0 0 0-1.028A28.9 28.9 0 0 0 3.105 2.288Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
};

export default ChatSystem;