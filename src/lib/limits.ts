// Plain constants shared by server validation and browser components. Kept dependency-free so
// importing them in a client component does not pull the validation library into the bundle.
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 4000;
