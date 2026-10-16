import Link from "next/link";
import { buttonVariants } from "@/components/ui";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">The page you are looking for does not exist, or you do not have access to it.</p>
      <Link href="/" className={buttonVariants({ className: "mt-6" })}>
        Go to the home page
      </Link>
    </main>
  );
}
