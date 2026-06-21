import React, { useState } from 'react';

/* ─── Relative time ─────────────────────────────────────────────────── */
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

/* ─── Media carousel ────────────────────────────────────────────────── */
function MediaCarousel({ urls, mediaType }) {
  const [active, setActive] = useState(0);
  if (!urls?.length) return null;

  if (mediaType === 'video') {
    return (
      <div className="w-full bg-black" style={{ aspectRatio: '4/3' }}>
        <video
          src={urls[0]}
          controls
          playsInline
          preload="metadata"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div className="relative w-full bg-slate-900 overflow-hidden" style={{ aspectRatio: '4/3' }}>
      <img
        src={urls[active]}
        alt="Item"
        className="w-full h-full object-cover transition-opacity duration-300"
      />

      {/* Dots */}
      {urls.length > 1 && (
        <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
          {urls.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`rounded-full transition-all ${
                i === active
                  ? 'w-4 h-1.5 bg-amber-400'
                  : 'w-1.5 h-1.5 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}

      {/* Arrow nav for multiple images */}
      {urls.length > 1 && (
        <>
          <button
            onClick={() => setActive((p) => (p - 1 + urls.length) % urls.length)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/50 rounded-full
                       flex items-center justify-center text-white text-xs"
          >
            ‹
          </button>
          <button
            onClick={() => setActive((p) => (p + 1) % urls.length)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/50 rounded-full
                       flex items-center justify-center text-white text-xs"
          >
            ›
          </button>
        </>
      )}
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────────── */
const PostCard = ({ post, onChatClick, onViewMap, onLike, currentUserUid }) => {
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.likesCount || 0);
  const [chatPulse, setChatPulse] = useState(false);

  const isInfluencer = post.isInfluencer;

  const handleLike = () => {
    setLiked((prev) => !prev);
    setLikeCount((c) => (liked ? c - 1 : c + 1));
    onLike?.(post.id);
  };

  const handleChat = () => {
    setChatPulse(true);
    setTimeout(() => setChatPulse(false), 600);
    onChatClick(post.creatorId);
  };

  return (
    <article
      className="relative overflow-hidden mb-3 mx-0"
      style={{
        background: isInfluencer
          ? 'linear-gradient(145deg, #0f172a 0%, #1a1200 100%)'
          : '#0c1120',
        border: isInfluencer
          ? '1px solid rgba(245,158,11,0.4)'
          : '1px solid rgba(51,65,85,0.6)',
        borderRadius: '20px',
        boxShadow: isInfluencer
          ? '0 0 0 1px rgba(245,158,11,0.15), 0 8px 32px rgba(0,0,0,0.5)'
          : '0 2px 16px rgba(0,0,0,0.3)',
        fontFamily: "'DM Sans', ui-sans-serif, sans-serif",
      }}
    >
      {/* Gold shimmer bar for influencers */}
      {isInfluencer && (
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{
            background: 'linear-gradient(90deg, transparent, #f59e0b 40%, #fbbf24 60%, transparent)',
            opacity: 0.8,
          }}
        />
      )}

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <div className="relative flex-shrink-0">
          <img
            src={post.creatorPhotoURL || '/placeholder-avatar.png'}
            alt={post.creatorName}
            className="w-10 h-10 rounded-full object-cover"
            style={{
              border: isInfluencer ? '2px solid #f59e0b' : '2px solid #334155',
            }}
          />
          {isInfluencer && (
            <span
              className="absolute -bottom-1 -right-1 text-[9px] font-black flex items-center justify-center rounded-full"
              style={{
                width: 16, height: 16,
                background: '#f59e0b',
                color: '#000',
              }}
            >
              ★
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-white leading-tight truncate">
              {post.creatorName}
            </span>
            {isInfluencer && (
              <span
                className="text-[9px] uppercase tracking-widest font-black px-2 py-px rounded-full"
                style={{ background: '#f59e0b', color: '#000' }}
              >
                Gold
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {post.location?.landmark && (
              <span className="text-[11px] text-slate-500 truncate">
                📍 {post.location.landmark}
              </span>
            )}
            <span className="text-[10px] text-slate-600">
              {relTime(post.timestamp)}
            </span>
          </div>
        </div>

        {/* More menu placeholder */}
        <button className="text-slate-600 hover:text-slate-400 px-1">⋯</button>
      </div>

      {/* ── Description ── */}
      {post.description && (
        <div className="px-4 pb-3">
          <p className="text-sm text-slate-200 leading-relaxed" style={{ lineHeight: '1.6' }}>
            {post.description}
          </p>
        </div>
      )}

      {/* ── Media ── */}
      <MediaCarousel urls={post.mediaURL} mediaType={post.mediaType} />

      {/* ── Actions ── */}
      <div
        className="flex items-center px-4 py-3 gap-1"
        style={{ borderTop: '1px solid rgba(51,65,85,0.4)' }}
      >
        {/* Like */}
        <button
          onClick={handleLike}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-all active:scale-90"
          style={{
            background: liked ? 'rgba(239,68,68,0.15)' : 'transparent',
            color: liked ? '#f87171' : '#64748b',
            border: liked ? '1px solid rgba(239,68,68,0.3)' : '1px solid transparent',
          }}
        >
          <span style={{ fontSize: 15 }}>{liked ? '❤️' : '🤍'}</span>
          <span className="font-semibold">{likeCount}</span>
        </button>

        {/* Map */}
        {post.location?.lat && (
          <button
            onClick={() => onViewMap(post.location)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-slate-500
                       hover:text-slate-300 transition-colors border border-transparent
                       hover:border-slate-700"
          >
            <span style={{ fontSize: 14 }}>🗺️</span>
            <span>Map</span>
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Chat CTA */}
        <button
          onClick={handleChat}
          className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold
                     transition-all active:scale-95"
          style={{
            background: chatPulse
              ? 'rgba(245,158,11,0.2)'
              : 'linear-gradient(135deg, #f59e0b, #d97706)',
            color: chatPulse ? '#f59e0b' : '#000',
            border: chatPulse ? '1px solid #f59e0b' : '1px solid transparent',
            letterSpacing: '0.01em',
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M2.5 3A1.5 1.5 0 0 0 1 4.5v.793c.026.009.051.02.076.032L7.674 8.51c.206.1.446.1.652 0l6.598-3.185A.755.755 0 0 1 15 5.293V4.5A1.5 1.5 0 0 0 13.5 3h-11Z" />
            <path fillRule="evenodd" d="M15 6.954 8.978 9.86a2.25 2.25 0 0 1-1.956 0L1 6.954V11.5A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.954Z" />
          </svg>
          Chat with Seller
        </button>
      </div>
    </article>
  );
};

export default PostCard;