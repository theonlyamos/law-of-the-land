import { createSchema } from "../node_modules/@convex-dev/better-auth/dist/client/create-schema.js";
import { getAuthTables } from "better-auth/db";
import { writeFile } from "node:fs/promises";
import { auth } from "../convex/betterAuth/auth";

const tables = getAuthTables(auth.options);
const output = await createSchema({
  file: "convex/betterAuth/generatedSchema.ts",
  tables,
});

await writeFile(output.path, output.code, "utf8");

console.log(
  `Generated ${output.path} with tables: ${Object.keys(tables).join(", ")}`,
);
