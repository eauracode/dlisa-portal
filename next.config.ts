import type { NextConfig } from "next";

// Every page in this application is personalised or permission-checked per request,
// so Cache Components / partial prefetching are intentionally not enabled.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts; 'unsafe-eval' is only needed by the dev server.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@huggingface/transformers", "onnxruntime-node"],
  // Function packaging on Vercel. The embedding runtime ships binaries for every platform
  // (~290 MB); functions run on Linux x64, so the rest are always left out. The AI library and
  // runtime are packaged only into /api/jobs/* (AI work is dispatched there; see
  // src/lib/matching/dispatch.ts). Keeping ~68 MB off every other route lets Vercel bundle them
  // together, which keeps the deployment within the Hobby plan's 12-function limit.
  outputFileTracingExcludes: {
    "/**": [
      "node_modules/onnxruntime-node/bin/napi-v*/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v*/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v*/linux/arm64/**",
      "node_modules/onnxruntime-web/**",
    ],
    ...Object.fromEntries(
      ["/", "/_not-found", "/admin", "/admin/**", "/student", "/student/**", "/memos", "/privacy", "/issues", "/api/admin/**"].map((route) => [
        route,
        ["node_modules/@huggingface/transformers/**", "node_modules/onnxruntime-node/**", "node_modules/onnxruntime-common/**", "node_modules/sharp/**", "node_modules/@img/**"],
      ]),
    ),
  },
  // The AI library and runtime are loaded dynamically (and are excluded from the shared trace
  // above), so the job routes list them explicitly.
  outputFileTracingIncludes: {
    "/api/jobs/**": [
      "node_modules/@huggingface/**",
      "node_modules/onnxruntime-common/**",
      "node_modules/onnxruntime-node/package.json",
      "node_modules/onnxruntime-node/dist/**",
      "node_modules/onnxruntime-node/lib/**",
      "node_modules/onnxruntime-node/bin/napi-v*/linux/x64/**",
      "node_modules/sharp/**",
      "node_modules/@img/**",
      "node_modules/detect-libc/**",
      "node_modules/semver/**",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
