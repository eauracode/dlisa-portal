import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { listFaqs } from "@/lib/services/faqs";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Label, PageHeader, Textarea } from "@/components/ui";
import { Flash } from "@/components/flash";
import { faqAction } from "../../actions";

export const metadata: Metadata = { title: "FAQs" };

export default async function FaqsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; q?: string }> }) {
  const admin = await requireAdmin("faqs.manage");
  const sp = await searchParams;
  const all = await listFaqs(pool(), admin);
  const q = (sp.q ?? "").trim().toLowerCase();
  const faqs = q ? all.filter((f) => `${f.question} ${f.answer}`.toLowerCase().includes(q)) : all;
  const active = all.filter((f) => f.active).length;
  const used = all.reduce((n, f) => n + f.used, 0);

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <PageHeader
        title="Frequently asked questions"
        description="When a student asks something listed here, the portal answers them instantly, with no staff member needed. Staff can also pick these answers when replying."
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Add a question</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={faqAction} className="grid gap-3.5">
              <input type="hidden" name="op" value="create" />
              <div>
                <Label htmlFor="faq-question">Question</Label>
                <Input id="faq-question" name="question" required minLength={5} maxLength={150} placeholder="When will the first-semester exam results be released?" />
              </div>
              <div>
                <Label htmlFor="faq-answer">Answer</Label>
                <Textarea id="faq-answer" name="answer" required minLength={5} maxLength={4000} rows={6} placeholder="Write the answer exactly as students should read it." />
              </div>
              <p className="text-xs text-muted">
                Write the question the way students ask it. Students get this answer when their message means the same thing, even in different words, and can
                tell you if it didn&apos;t help.
              </p>
              <Button>Add FAQ</Button>
            </form>
          </CardContent>
        </Card>

        <section className="grid gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-sm text-muted">
              {active} active · answered students {used} time{used === 1 ? "" : "s"}
            </p>
            <form className="flex gap-2">
              <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search FAQs" aria-label="Search FAQs" className="w-56" />
              <Button variant="secondary" size="sm">
                Search
              </Button>
            </form>
          </div>
          {faqs.length === 0 ? (
            <EmptyState title={all.length ? "No FAQ matches that search." : "No FAQs yet."}>
              {!all.length && "Add the questions students ask most often, such as exam dates, fees and registration deadlines."}
            </EmptyState>
          ) : (
            faqs.map((f) => (
              <Card key={f.id} className={f.active ? "" : "opacity-70"}>
                <CardContent className="grid gap-2 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={f.active ? "ok" : "neutral"}>{f.active ? "Active" : "Switched off"}</Badge>
                    <span className="text-xs text-muted">
                      Sent to {f.used} student{f.used === 1 ? "" : "s"}
                      {f.helpful + f.not_helpful > 0 && ` · ${f.helpful} helpful, ${f.not_helpful} not helpful`} · updated {formatDateTime(f.updated_at)} by {f.author}
                    </span>
                  </div>
                  <b>{f.question}</b>
                  <p className="whitespace-pre-line text-sm text-muted">{f.answer}</p>
                  <details>
                    <summary className="cursor-pointer text-sm font-semibold text-link">Edit</summary>
                    <form action={faqAction} className="mt-3 grid gap-2 border-t border-border pt-3">
                      <input type="hidden" name="op" value="edit" />
                      <input type="hidden" name="faqId" value={f.id} />
                      <Input name="question" defaultValue={f.question} required minLength={5} maxLength={150} aria-label="Question" />
                      <Textarea name="answer" defaultValue={f.answer} required minLength={5} maxLength={4000} rows={5} aria-label="Answer" />
                      <div>
                        <Button size="sm">Save changes</Button>
                      </div>
                    </form>
                  </details>
                  <form action={faqAction}>
                    <input type="hidden" name="op" value={f.active ? "off" : "on"} />
                    <input type="hidden" name="faqId" value={f.id} />
                    <Button size="sm" variant="ghost">
                      {f.active ? "Switch off" : "Switch on"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            ))
          )}
        </section>
      </div>
    </>
  );
}
