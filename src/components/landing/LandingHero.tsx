import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

const FEATURES = [
  { icon: "bolt", title: "Under a minute", sub: "A few quick answers" },
  { icon: "eye", title: "Track it live", sub: "Every update, in one chat" },
  { icon: "shield", title: "Anonymous by design", sub: "Just a username you pick" },
  { icon: "users", title: "Stronger together", sub: "Same problems get grouped" },
] as const;

/** Landing hero with the inauguration photo blended in (CSS background: decorative, no layout shift). */
export function LandingHero() {
  return (
    <section className="lp-hero" aria-labelledby="hero-title">
      <div className="mx-auto max-w-[1100px] min-[860px]:px-2">
        <div className="lp-hero-grid grid items-center gap-10 min-[860px]:grid-cols-[1.15fr_.85fr]">
          <div>
            <span className="text-[13px] font-bold uppercase tracking-[.04em] text-[#F7C9D6]">Your voice matters</span>
            <h1 id="hero-title" className="mt-2.5 max-w-[16ch] text-[clamp(34px,7vw,56px)] font-extrabold leading-[1.04] tracking-[-.03em]">
              Got a complaint or a suggestion? Tell the Student Union.
            </h1>
            <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-[#F0DDE3]">
              Send a complaint or suggestion in under a minute, and get a response instantly. No more delay or waiting!
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/student/complaints/new"
                className="inline-flex min-h-14 items-center gap-2 rounded-lg bg-white px-5 font-semibold text-[#3F0014] no-underline hover:bg-[#FBEFF2]"
              >
                Submit a complaint or suggestion <Icon name="send" size={16} />
              </Link>
              <Link
                href="/student/access"
                className="inline-flex min-h-14 items-center rounded-lg border border-white/70 px-5 font-semibold text-white no-underline hover:bg-white/10"
              >
                Track my complaints &amp; suggestions
              </Link>
            </div>
            <p className="mt-5 flex items-start gap-2 text-[13px] text-[#E2C6CF]">
              <Icon name="shield" size={16} className="mt-0.5" />
              <span>
                No name, email, phone or matric number. Just a username you choose.{" "}
                <Link href="/privacy" className="text-white">
                  How your privacy is protected
                </Link>
              </span>
            </p>
          </div>

          {/* Desktop-only decorative chat preview. No counts of other students. */}
          <div className="lp-hero-chat" aria-hidden="true">
            <div className="flex items-center gap-2.5 border-b border-[#EFE7E9] pb-2.5 text-sm">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[#700023] text-xs font-bold text-white">DLI</span>
              <div>
                <b>FIN 231 timetable</b>
                <small className="block text-xs text-[#665A5D]">with DLI Student Union</small>
              </div>
            </div>
            <div className="b m">The FIN 231 timetable isn&apos;t on the portal yet.</div>
            <span className="pill">Added to an issue the Union is working on</span>
            <div className="b t u">
              <b>UPDATE</b>We&apos;ve raised this with the Exams Office.
            </div>
          </div>
        </div>

        <ul className="mt-11 grid grid-cols-2 border-t border-white/20 min-[860px]:grid-cols-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex items-center gap-3 py-5 pr-3 text-sm leading-snug text-[#F3E3E8]">
              <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full border-[1.5px] border-white/50">
                <Icon name={f.icon} />
              </span>
              <span>
                <b className="block font-semibold text-white">{f.title}</b>
                {f.sub}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
