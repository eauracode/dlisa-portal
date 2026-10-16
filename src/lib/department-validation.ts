import { z } from "zod";
import { DEPARTMENT_CODES } from "./departments";

// Required when creating a new username, or when an existing student has no department yet.
// (Zod 4: the message option replaces Zod 3's errorMap.)
export const departmentField = z.enum(DEPARTMENT_CODES, { message: "Choose your department." });

export const newStudentSchemaExtension = z.object({
  department: departmentField,
});
