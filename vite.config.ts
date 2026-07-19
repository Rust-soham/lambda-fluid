import { defineConfig } from "vite-plus";

const ignoredPaths = [
  ".agents/**",
  ".repos/**",
  ".alchemy/**",
  ".turbo/**",
  "build/**",
  "dist/**",
  "node_modules/**",
];

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["packages/**/*.test.ts"],
  },
  lint: {
    ignorePatterns: ignoredPaths,
    plugins: ["typescript", "import", "node", "unicorn", "promise"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ignoredPaths,
    printWidth: 88,
    tabWidth: 2,
    semi: true,
    singleQuote: false,
    trailingComma: "es5",
    jsxSingleQuote: false,
    sortPackageJson: true,
  },
});
