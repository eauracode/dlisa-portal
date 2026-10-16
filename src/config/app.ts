import { brand } from "./brand";

/**
 * App configuration. Branding (names, logos, footer credit) lives in ./brand.ts and colours in
 * src/styles/theme-tokens.css, so the Union can swap them without touching any pages.
 */
export const APP_CONFIG = {
  name: brand.fullName,
  shortName: brand.portalName,
  organisation: brand.orgLine,
  // All dates are displayed and entered in Lagos time (WAT, UTC+01:00, no daylight saving).
  timeZone: "Africa/Lagos",
  utcOffset: "+01:00",
  locale: "en-NG",
};

export const COPY = {
  acknowledgement:
    "Your submission has been received. The DLI Student Union team will review it and provide updates through your dashboard. You can return at any time to check its status.",
  noDeadline: "An expected resolution time has not yet been confirmed.",
  matchedExisting:
    "Your concern matches an existing issue that is already being addressed. Your submission has been added to that issue. You can follow updates from this page.",
  resolved: "This issue has been marked as resolved. If your concern remains unresolved, you can request a review.",
  awaitingReview: "Your submission has been received and is awaiting review.",
  emptyDashboard: "You have not sent any complaints or suggestions yet. When you do, they will appear here.",
};
