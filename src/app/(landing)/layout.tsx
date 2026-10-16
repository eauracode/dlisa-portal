import { PublicChrome } from "@/components/public-chrome";

// The landing page always uses the public header (with "My dashboard" when signed in).
export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <PublicChrome wide>{children}</PublicChrome>;
}
