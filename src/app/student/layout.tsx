import { AdaptiveChrome } from "@/components/public-chrome";

// Signed in: the student shell. Signed out (access page, first submission): the public layout.
export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return <AdaptiveChrome>{children}</AdaptiveChrome>;
}
