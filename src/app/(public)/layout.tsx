import { AdaptiveChrome } from "@/components/public-chrome";

// Memos, privacy and the old issues page: inside the student shell when signed in.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <AdaptiveChrome>{children}</AdaptiveChrome>;
}
