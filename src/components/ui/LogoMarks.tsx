import { brand } from "@/config/brand";

/** UNILAG + DLISA logos side by side. Used in the student header and staff sidebar only. */
export function LogoMarks({ size = 40, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center gap-1.5 ${onDark ? "rounded-lg bg-white px-2 py-1.5" : ""}`}>
      {brand.logos.map((logo, i) => (
        <span key={logo.src} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true" className={`h-7 w-px ${onDark ? "bg-[#E7DFE1]" : "bg-[var(--border)]"}`} />}
          {/* Plain <img>: tiny files, no next/image runtime needed on student pages */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logo.src}
            alt={logo.alt}
            width={size}
            height={size}
            className="rounded-md bg-white object-contain p-0.5"
            style={{ width: size, height: size }}
          />
        </span>
      ))}
    </span>
  );
}
