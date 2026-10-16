import { redirect } from "next/navigation";

// "Ongoing issues" now lives in Memos as "Issue update" cards.
export default function IssuesRedirect() {
  redirect("/memos?type=issue");
}
