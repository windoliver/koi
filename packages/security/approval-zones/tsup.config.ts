import { defineConfig, type Options } from "tsup";

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
};

const built: ReturnType<typeof defineConfig> = defineConfig(config);
export default built;
