import Script from "next/script";

// Applies a saved theme before first paint so there is no light/dark flash. With no saved
// choice, CSS follows the device. next/script's beforeInteractive injects it into the
// initial HTML ahead of hydration (a raw <script> element triggers a React 19 warning).
const code = `(function(){try{var t=localStorage.getItem('dli-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;

export function ThemeScript() {
  return (
    // Rendered only from the root layout (app/layout.tsx), which is where the App Router docs
    // require beforeInteractive scripts; this lint rule predates the App Router.
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script id="dli-theme" strategy="beforeInteractive">
      {code}
    </Script>
  );
}
