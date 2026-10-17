import { LandingHero } from "@/components/landing/LandingHero";

const STEPS = [
  { title: "Chat it in", text: "Answer a few quick questions about your complaint or suggestion. No name, email or matric number." },
  { title: "We group and act", text: "Reports of the same problem are grouped so the Students' Association can act on them together." },
  { title: "Follow the thread", text: "Every reply, update and status change lands in one conversation you can come back to." },
];

export default function LandingPage() {
  return (
    <>
      <LandingHero />

      <section aria-labelledby="how" className="mx-auto max-w-[1180px] px-4 py-10 sm:px-6">
        <h2 id="how" className="text-xl font-bold tracking-tight">
          How it works
        </h2>
        <ol className="mt-5 grid gap-4 min-[860px]:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--brand-100)] text-sm font-bold text-[var(--link)]">{i + 1}</span>
              <h3 className="mt-3 text-base font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
