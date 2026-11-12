// Types for the generated Ajv standalone validator (see scripts/gen_schema.ts).
export interface ValidateFn {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
}
export declare const validate: ValidateFn;
export default validate;
