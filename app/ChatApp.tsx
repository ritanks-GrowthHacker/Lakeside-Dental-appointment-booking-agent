"use client";

import { useEffect, useRef, useState } from "react";
import "./ChatApp.css";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
}

const SUGGESTIONS = [
  "What times are open tomorrow?",
  "I'd like to book an appointment",
  "I need to cancel my appointment",
];

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function ChatApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: newId(),
      role: "assistant",
      content:
        "Hi, you've reached Lakeside Dental Clinic scheduling. I can check availability, book an appointment, or cancel one for you — what do you need?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const sessionIdRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!sessionIdRef.current) {
    sessionIdRef.current = newId();
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isSending]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    setMessages((prev) => [...prev, { id: newId(), role: "user", content: trimmed }]);
    setInput("");
    setIsSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, message: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "error", content: data?.error || "Something went wrong. Please try again." },
        ]);
        return;
      }

      setMessages((prev) => [...prev, { id: newId(), role: "assistant", content: data.reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "error", content: "Couldn't reach the server. Try refreshing the page." },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  const showSuggestions = messages.length === 1;

  return (
    <div className="page">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Lakeside Dental Clinic</h1>
              <p className="brand-sub">Scheduling desk</p>
            </div>
          </div>
        </div>
        <svg className="ripple" viewBox="0 0 1200 40" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M0 20 C 100 0, 200 40, 300 20 S 500 0, 600 20 S 800 40, 900 20 S 1100 0, 1200 20 V40 H0 Z"
            fill="var(--color-lake)"
            opacity="0.12"
          />
        </svg>
      </header>

      <main className="chat-shell">
        <div className="chat-scroll" ref={scrollRef}>
          <ul className="chat-list">
            {messages.map((m) => (
              <li key={m.id} className={`bubble-row bubble-row--${m.role}`}>
                <div className={`bubble bubble--${m.role}`}>{m.content}</div>
              </li>
            ))}
            {isSending && (
              <li className="bubble-row bubble-row--assistant">
                <div className="bubble bubble--assistant bubble--typing" aria-live="polite">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              </li>
            )}
          </ul>

          {showSuggestions && (
            <div className="suggestions" aria-label="Suggested messages">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="suggestion-chip" onClick={() => sendMessage(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            aria-label="Message"
            disabled={isSending}
          />
          <button type="submit" disabled={isSending || !input.trim()}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
