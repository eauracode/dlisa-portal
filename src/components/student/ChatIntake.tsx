"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { DEPARTMENTS } from "@/lib/departments";
import { DESCRIPTION_MAX, DESCRIPTION_MIN } from "@/lib/limits";
import {
  chatStatusAction,
  checkReturningUsernameAction,
  checkUsernameAction,
  chatAnswerFeedbackAction,
  chatFollowUpAction,
  submitChatComplaintAction,
} from "@/app/student/actions";
import { BotAvatar } from "./ChatBits";

/*
 * Chat-style intake for a complaint or suggestion. Progressive enhancement: the page renders
 * the classic form first and swaps to this once JavaScript runs. Submission goes through the
 * same server rules as the form (validation, username, department, rate limits, duplicates).
 */

const USERNAME_HINT = "3–24 letters, numbers, dots, hyphens or underscores. If you want to stay anonymous, avoid your real name or matric number.";
const THANKS = "Thank you for reaching out. If you have any other issues or feedback, do not hesitate to reach out.";
const SUBMITTED = "Your submission has been received, and is being redirected to the right office as we speak — this page updates automatically.";
const VALID = /^[A-Za-z0-9._-]{3,24}$/;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { id: number; from: "bot" | "me" | "sys"; node: React.ReactNode };
type Step =
  | { kind: "chips"; options: string[]; primaryFirst?: boolean }
  | { kind: "username"; mode: "new" | "returning" }
  | { kind: "text"; min?: number; max?: number }
  | { kind: "none" };
type ChatState = { msgs: Msg[]; step: Step; stepKey: number; typing: boolean };

/*
 * The conversation lives outside React. Signing up or signing in from the chat changes the
 * page layout (public header -> student shell), which remounts this component; keeping the
 * state and the running flow here lets the remounted chat carry on exactly where it was.
 */
const INITIAL: ChatState = { msgs: [], step: { kind: "none" }, stepKey: 0, typing: false };
let chat: ChatState = INITIAL;
let running = false;
// Set when the chat has finished on this page; the next visit to the page starts afresh.
let ended = false;
let resolver: ((v: string) => void) | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
// The mounted component's navigation and "use a form" handlers (updated on every mount).
const handlers: { navigate: (href: string) => void; switchToForm: () => void } = { navigate: () => {}, switchToForm: () => {} };

function update(patch: Partial<ChatState>) {
  chat = { ...chat, ...patch };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const push = (from: Msg["from"], node: React.ReactNode) => update({ msgs: [...chat.msgs, { id: ++nextId, from, node }] });
async function bot(node: React.ReactNode, delay = 250) {
  update({ typing: true });
  await wait(delay);
  update({ typing: false });
  push("bot", node);
}
const me = (text: string) => push("me", text);
function ask(s: Step) {
  return new Promise<string>((res) => {
    resolver = res;
    update({ step: s, stepKey: chat.stepKey + 1 });
  });
}
function answer(v: string) {
  update({ step: { kind: "none" } });
  const r = resolver;
  resolver = null;
  r?.(v);
}
/** The conversation is over: no more prompts; the next visit starts a fresh chat. */
function end() {
  ended = true;
  update({ step: { kind: "none" } });
}

/** Finished: the next visit to the page starts a fresh conversation. */
function finish(href: string) {
  running = false;
  chat = INITIAL;
  handlers.navigate(href);
}

async function askDepartment() {
  await bot(
    <>
      Which department are you in?
      <span className="hint2">Saved with your username so the Association can route things to the right people. You only pick it once.</span>
    </>,
  );
  const name = await ask({ kind: "chips", options: DEPARTMENTS.map((d) => d.name) });
  me(name);
  return DEPARTMENTS.find((d) => d.name === name)!.code;
}

async function runChat(opts: { signedInAs: string | null; needsDepartment: boolean; categories: { id: number; name: string }[] }) {
  await wait(0);
  const fd = new FormData();
  if (!opts.signedInAs) {
    await bot("Hi! I'll help you send a complaint or suggestion to the DLI Students' Association. It takes under a minute.", 150);
    await bot("First, are you new here?");
    const c = await ask({ kind: "chips", options: ["I'm new here", "I have a username"] });
    me(c);
    if (c.startsWith("I'm new")) {
      await bot(
        <>
          Pick a username. You&apos;ll use it to come back and follow the conversation.
          <span className="hint2">{USERNAME_HINT}</span>
        </>,
      );
      const username = await ask({ kind: "username", mode: "new" });
      me(username);
      fd.set("mode", "new");
      fd.set("username", username);
      fd.set("department", await askDepartment());
    } else {
      await bot("What's your username?");
      const username = await ask({ kind: "username", mode: "returning" });
      me(username);
      fd.set("mode", "returning");
      fd.set("username", username);
      const check = await checkReturningUsernameAction(username);
      await bot(`Welcome back, ${username}.`);
      if (check.needsDepartment) fd.set("department", await askDepartment());
    }
    await bot("What's it about?");
  } else {
    await bot(`Hi ${opts.signedInAs}. What would you like to tell the Students' Association about?`, 150);
    if (opts.needsDepartment) {
      fd.set("department", await askDepartment());
      await bot("Thanks. What's it about?");
    }
  }

  const category = await ask({ kind: "chips", options: opts.categories.map((c) => c.name) });
  me(category);
  fd.set("categoryId", String(opts.categories.find((c) => c.name === category)!.id));
  await bot(
    <>
      Tell me what happened, or what you&apos;d like to see changed.
      <span className="hint2">Mention the course code, office or study centre, and when it started.</span>
    </>,
  );
  const description = await ask({ kind: "text" });
  me(description);
  fd.set("description", description);

  await bot(
    <>
      Here&apos;s what I&apos;ll send. Check it over.
      <span className="sum">
        <b>Category:</b> {category}
        <br />
        <b>Details:</b> {description.length > 220 ? `${description.slice(0, 220)}…` : description}
      </span>
      <span className="hint2">Only you and the Students&apos; Association team can read this.</span>
    </>,
  );
  const pick = await ask({ kind: "chips", options: ["Send it", "Start over"], primaryFirst: true });
  if (pick === "Start over") {
    window.location.reload();
    return;
  }
  me("Send it");

  update({ typing: true });
  const res = await submitChatComplaintAction(fd);
  update({ typing: false });
  if (!res.ok) {
    if (res.duplicateOf) {
      await bot(res.message);
      await ask({ kind: "chips", options: ["Open it"], primaryFirst: true });
      return finish(`/student/complaints/${res.duplicateOf}?duplicate=1`);
    }
    await bot(
      <>
        {res.message}
        <span className="hint2">Nothing was sent. You can start over, or use the form instead.</span>
      </>,
    );
    const next = await ask({ kind: "chips", options: ["Start over", "Use the form"], primaryFirst: true });
    if (next === "Use the form") {
      running = false;
      chat = INITIAL;
      handlers.switchToForm();
    } else window.location.reload();
    return;
  }

  // The typing indicator stands in for a status message while matching runs.
  update({ typing: true });
  let status = await chatStatusAction(res.complaintId);
  for (let i = 0; i < 10 && status?.state === "checking"; i++) {
    await wait(2000);
    status = await chatStatusAction(res.complaintId);
  }
  update({ typing: false });
  const answers = status?.answers ?? [];
  if (answers.length) {
    // An earlier Association answer to the same question: reply with it directly, like a live agent.
    for (const a of answers) await bot(a.body, 250);
    const ids = answers.map((a) => a.messageId);
    const verdict = await ask({ kind: "chips", options: ["Helpful", "Not helpful"], primaryFirst: true });
    me(verdict);
    if (verdict === "Helpful") {
      await chatAnswerFeedbackAction(res.complaintId, ids, true);
      await bot(THANKS);
      return end();
    }
    await chatAnswerFeedbackAction(res.complaintId, ids, false);
    await bot("Sorry about that. Tell me what you still need. It goes straight to the Students' Association team, who will reply to you personally.");
    for (;;) {
      const more = await ask({ kind: "text", min: 1, max: 2000 });
      me(more);
      update({ typing: true });
      const sent = await chatFollowUpAction(res.complaintId, more);
      update({ typing: false });
      if (sent.ok) break;
      await bot(sent.message ?? "That didn't send. Please try again.");
      if (sent.message?.includes("wait") || sent.message?.includes("closed")) return end();
    }
    await bot(SUBMITTED);
    return end();
  }
  await bot(SUBMITTED, 200);
  const go = await ask({ kind: "chips", options: ["Open the conversation", "Go to my complaints & suggestions"], primaryFirst: true });
  finish(go.startsWith("Open") ? `/student/complaints/${res.complaintId}` : "/student/complaints");
}

export function ChatIntake(props: {
  signedInAs: string | null;
  needsDepartment: boolean;
  categories: { id: number; name: string }[];
  onSwitchToForm: () => void;
}) {
  const router = useRouter();
  const { msgs, step, stepKey, typing } = useSyncExternalStore(subscribe, () => chat, () => INITIAL);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { signedInAs, needsDepartment, categories, onSwitchToForm } = props;

  useEffect(() => {
    handlers.navigate = (href) => router.push(href);
    handlers.switchToForm = onSwitchToForm;
  }, [router, onSwitchToForm]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, typing, step]);

  useEffect(() => {
    // A new visit after a finished chat: start from a clean slate.
    if (!ended) return;
    ended = false;
    running = false;
    chat = INITIAL;
    listeners.forEach((l) => l());
  }, []);

  useEffect(() => {
    // Starts once per visit, even if React runs effects twice or the component remounts.
    if (running) return;
    running = true;
    runChat({ signedInAs, needsDepartment, categories }).catch(() => {
      update({ typing: false });
      push("bot", "Something went wrong sending that. Please try again, or use the form instead.");
      running = false;
    });
  }, [signedInAs, needsDepartment, categories]);

  return (
    <section
      aria-label="New complaint or suggestion"
      className="flex h-[min(760px,calc(100dvh-190px))] min-h-[440px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
    >
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold">New complaint or suggestion</h1>
          <small className="text-xs text-[var(--muted)]">Automated assistant · takes under a minute</small>
        </div>
        <button
          type="button"
          onClick={onSwitchToForm}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-transparent px-3 text-sm font-semibold text-[var(--foreground)]"
        >
          <Icon name="form" size={16} />
          <span className="hidden sm:inline">Use a form</span>
          <span className="sr-only sm:hidden">Use a form</span>
        </button>
      </header>

      <div ref={bodyRef} role="log" aria-live="polite" aria-label="Conversation" className="chat-body flex flex-1 flex-col gap-2 overflow-y-auto bg-[var(--sunken)] px-3 py-[18px] sm:px-4">
        {msgs.map((m) =>
          m.from === "sys" ? (
            <span key={m.id} className="sysp">
              <Icon name="users" size={16} />
              {m.node}
            </span>
          ) : m.from === "me" ? (
            <div key={m.id} className="flex justify-end">
              <div className="bubble-me">{m.node}</div>
            </div>
          ) : (
            <div key={m.id} className="flex items-end gap-2">
              <BotAvatar small />
              <div className="bubble-them">{m.node}</div>
            </div>
          ),
        )}
        {typing && (
          <div className="flex items-end gap-2">
            <BotAvatar small />
            <div className="bubble-them typing" aria-label="Typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <Composer key={stepKey} step={step} onAnswer={answer} />
    </section>
  );
}

/** Re-mounted for every question (keyed), so each step starts with an empty box. */
function Composer({ step, onAnswer }: { step: Step; onAnswer: (v: string) => void }) {
  const [val, setVal] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ticket = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const wrap = "border-t border-[var(--border)] bg-[var(--surface)] px-3 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5";
  if (step.kind === "none") return <div className={wrap} />;

  if (step.kind === "chips") {
    return (
      <div className={wrap}>
        <div role="group" aria-label="Choose one" className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
          {step.options.map((o, i) => (
            <button
              key={o}
              type="button"
              onClick={() => onAnswer(o)}
              autoFocus={i === 0}
              className={`min-h-10 cursor-pointer rounded-full border-[1.5px] border-[var(--brand-600)] px-3.5 text-sm font-medium ${
                step.primaryFirst && i === 0 ? "bg-[var(--brand-600)] text-white" : "bg-[var(--surface)] text-[var(--link)] hover:bg-[var(--brand-50)]"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const isText = step.kind === "text";
  const n = val.trim().length;
  const minChars = step.kind === "text" ? (step.min ?? DESCRIPTION_MIN) : 0;
  const maxChars = step.kind === "text" ? (step.max ?? DESCRIPTION_MAX) : 0;
  const canSend = isText ? n >= minChars : !!status?.ok;

  // Debounced username check, run from the input handler (new: available? returning: exists?).
  function onUsername(v: string) {
    setVal(v);
    clearTimeout(timer.current);
    const t = ++ticket.current;
    const value = v.trim();
    if (!value) return setStatus(null);
    if (!VALID.test(value)) return setStatus({ ok: false, text: "Use 3–24 letters, numbers, dots, hyphens or underscores." });
    setStatus({ ok: false, text: "Checking…" });
    timer.current = setTimeout(async () => {
      const mode = step.kind === "username" ? step.mode : "new";
      const r =
        mode === "new"
          ? await checkUsernameAction(value).then((c) => ({ ok: c.status === "available", message: c.message }))
          : await checkReturningUsernameAction(value);
      if (t === ticket.current) setStatus({ ok: r.ok, text: r.message });
    }, 450);
  }

  return (
    <form
      className={wrap}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onAnswer(val.trim());
      }}
    >
      {!isText && status && (
        <p
          role="status"
          className={`mx-1.5 mb-1.5 text-[13px] ${status.ok ? "font-medium text-[var(--ok-fg)]" : status.text === "Checking…" ? "text-[var(--muted)]" : "font-medium text-[var(--danger-fg)]"}`}
        >
          {status.ok ? "✓ " : ""}
          {status.text}
        </p>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">
          {isText ? "Describe it" : step.mode === "new" ? "Choose a username" : "Your username"}
        </label>
        {isText ? (
          <textarea
            id="chat-input"
            autoFocus
            rows={1}
            maxLength={maxChars}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="Type it here…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 860px)").matches) {
                e.preventDefault();
                if (canSend) onAnswer(val.trim());
              }
            }}
            className="max-h-40 min-h-11 flex-1 resize-none rounded-[22px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2.5 text-base [field-sizing:content]"
          />
        ) : (
          <input
            id="chat-input"
            autoFocus
            value={val}
            onChange={(e) => onUsername(e.target.value)}
            maxLength={24}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={step.mode === "new" ? "Pick a username" : "Your username"}
            className="min-h-11 min-w-0 flex-1 rounded-[22px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-base"
          />
        )}
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-[var(--brand-600)] text-white disabled:cursor-not-allowed disabled:bg-[var(--border-strong)]"
        >
          <Icon name="send" />
        </button>
      </div>
      {isText && (
        <div className="mx-2 mt-1.5 flex justify-between text-xs text-[var(--muted)]">
          <span>{n < minChars ? `${minChars - n} more characters needed` : "Looks good"}</span>
          <span className="tabular-nums">
            {val.length.toLocaleString()} / {maxChars.toLocaleString()}
          </span>
        </div>
      )}
    </form>
  );
}
