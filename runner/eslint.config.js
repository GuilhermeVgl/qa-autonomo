import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  ...tseslint.configs.strict,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
