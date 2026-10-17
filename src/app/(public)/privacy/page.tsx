import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-[640px] space-y-4 leading-relaxed">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy notice</h1>
      <p>
        This portal is run by the DLI Students&apos; Association, University of Lagos, under the oversight of school management. We only collect what&apos;s
        needed to handle your complaint or suggestion: the username you choose, your department, the category, what you write, and any
        messages you send in a complaint&apos;s chat.
      </p>
      <h2 className="text-base font-semibold">Your department</h2>
      <p>
        Your department is collected and saved with your username so complaints can be sorted by department and routed to the right people.
        You choose it once. Staff only see a department next to a report when at least five students from that department reported the same
        issue, and never for harassment or safety reports.
      </p>
      <h2 className="text-base font-semibold">What we do not collect</h2>
      <p>
        We never ask for your name, email, phone number, matriculation number or photo, and we do not use third-party analytics. There is no
        password or PIN. Limited technical security information (for example, a scrambled form of your network address used to stop automated
        abuse) is kept briefly and is not used to identify you.
      </p>
      <h2 className="text-base font-semibold">Who can see your submissions</h2>
      <p>
        Only you can see your own submissions in your dashboard. Students&apos; Association staff see you as a reporter code such as &ldquo;Reporter
        89D22E&rdquo;, not your username. An Association Administrator can send a message to a username directly, but staff are not shown which
        reports a username made. Messages you send in a complaint&apos;s chat are read only by Students&apos; Association staff. School management oversight officers see records only for issues escalated to them. Public pages show
        only summaries the Association has approved, with nothing that identifies anyone. Harassment and safety reports are never shown publicly.
      </p>
      <h2 className="text-base font-semibold">Answers given before</h2>
      <p>
        If the Students&apos; Association has already answered the same question, for example in a memo or a reply to students who reported the same
        problem, that answer may be shown to you straight away. Your own messages are never shown to other students.
      </p>
      <h2 className="text-base font-semibold">Automated processing</h2>
      <p>
        Submissions are compared automatically to group reports of the same problem. Depending on configuration, this may use an external AI
        service; identifiers such as emails and phone numbers are removed before text is sent, and complaint text is not used to train public
        models. A person reviews uncertain groupings and all important decisions.
      </p>
      <h2 className="text-base font-semibold">Keep your username to yourself</h2>
      <p>
        Your username is the only thing that links you to your submissions, so anyone who knows it can read them. Choose a username others will
        not guess and do not share it. You stay signed in on your own device for 30 days; on a shared device, sign out when you finish.
      </p>
    </article>
  );
}
